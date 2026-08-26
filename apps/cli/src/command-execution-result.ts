import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { finished as streamFinished } from "node:stream/promises";
import type { ProgramContext } from "./program-context.js";

export type CommandOutputStream = "stdout" | "stderr";

export interface CommandOutputRecord {
  readonly sequence: number;
  readonly stream: CommandOutputStream;
  readonly bytes: Uint8Array;
}

export interface CommandOutputSummary {
  readonly rawBytes: number;
  readonly recordCount: number;
  readonly sha256: string;
}

export interface CommandOutput {
  readonly summary: CommandOutputSummary;
  records(offset?: number): AsyncIterable<CommandOutputRecord>;
  dispose(): Promise<void>;
}

export interface CommandExecutionResult {
  readonly output?: CommandOutput;
  readonly frames: readonly {
    readonly stream: CommandOutputStream;
    readonly bytesBase64: string;
  }[];
  readonly exitCode: number;
}

export type CommandExecutionMode = "cold" | "warm" | "fallback";

export interface DispatchedCommandResult {
  readonly mode: CommandExecutionMode;
  readonly result: CommandExecutionResult;
}

export interface CliExecutionRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly telemetryEnabled: boolean;
  readonly executionMode?: CommandExecutionMode;
}

export interface OrderedCommandOutputOptions {
  readonly inlineBytes?: number;
  readonly directory?: string;
}

const DEFAULT_INLINE_BYTES = 256 * 1024;
const MAXIMUM_RECORD_BYTES = 64 * 1024;
const RECORD_HEADER_BYTES = 9;

class CommandOutputWritable extends Writable {
  constructor(
    private readonly stream: CommandOutputStream,
    private readonly append: (stream: CommandOutputStream, bytes: Uint8Array) => Promise<void>,
  ) {
    super();
  }

  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
    void this.append(this.stream, bytes).then(() => callback(), callback);
  }
}

class StoredCommandOutput implements CommandOutput {
  constructor(
    readonly summary: CommandOutputSummary,
    private readonly inlineRecords: readonly CommandOutputRecord[],
    private readonly filePath?: string,
  ) {}

  async *records(offset = 0): AsyncIterable<CommandOutputRecord> {
    const records =
      this.filePath === undefined
        ? this.inlineRecords
        : OrderedCommandOutput.decodeRecords(await readFile(this.filePath));
    for (const record of records) {
      if (record.sequence >= offset) yield record;
    }
  }

  async dispose(): Promise<void> {
    if (this.filePath === undefined) return;
    await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export class OrderedCommandOutput {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  private readonly inlineBytes: number;
  private readonly directory: string;
  private readonly hash = createHash("sha256");
  private readonly inlineRecords: CommandOutputRecord[] = [];
  private pending: { stream: CommandOutputStream; bytes: Buffer } | undefined;
  private file: FileHandle | undefined;
  private filePath: string | undefined;
  private rawBytes = 0;
  private recordCount = 0;
  private finished = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: OrderedCommandOutputOptions = {}) {
    this.inlineBytes = options.inlineBytes ?? DEFAULT_INLINE_BYTES;
    this.directory = options.directory ?? tmpdir();
    this.stdout = new CommandOutputWritable("stdout", (stream, bytes) =>
      this.enqueue(stream, bytes),
    );
    this.stderr = new CommandOutputWritable("stderr", (stream, bytes) =>
      this.enqueue(stream, bytes),
    );
  }

  async finish(exitCode: number): Promise<CommandExecutionResult> {
    if (this.finished) throw new Error("Command output is already finished");
    this.stdout.end();
    this.stderr.end();
    await Promise.all([streamFinished(this.stdout), streamFinished(this.stderr)]);
    this.finished = true;
    await this.flushPending();
    await this.file?.close();
    this.file = undefined;
    const storedOutput = new StoredCommandOutput(
      {
        rawBytes: this.rawBytes,
        recordCount: this.recordCount,
        sha256: this.hash.digest("hex"),
      },
      [...this.inlineRecords],
      this.filePath,
    );
    const frames = [];
    for await (const record of storedOutput.records()) {
      frames.push({
        stream: record.stream,
        bytesBase64: Buffer.from(record.bytes).toString("base64"),
      });
    }
    return {
      output: storedOutput,
      frames,
      exitCode,
    };
  }

  async replaceWith(result: CommandExecutionResult): Promise<CommandExecutionResult> {
    await this.dispose();
    return result;
  }

  async dispose(): Promise<void> {
    await this.file?.close();
    this.file = undefined;
    if (this.filePath === undefined) return;
    await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.filePath = undefined;
  }

  private async append(stream: CommandOutputStream, bytes: Uint8Array): Promise<void> {
    if (this.finished) throw new Error("Command output is already finished");
    for (let offset = 0; offset < bytes.byteLength; offset += MAXIMUM_RECORD_BYTES) {
      const chunk = Buffer.from(
        bytes.buffer,
        bytes.byteOffset + offset,
        Math.min(MAXIMUM_RECORD_BYTES, bytes.byteLength - offset),
      );
      if (
        this.pending?.stream === stream &&
        this.pending.bytes.byteLength + chunk.byteLength <= MAXIMUM_RECORD_BYTES
      ) {
        this.pending = { stream, bytes: Buffer.concat([this.pending.bytes, chunk]) };
        continue;
      }
      await this.flushPending();
      this.pending = { stream, bytes: Buffer.from(chunk) };
    }
  }

  private enqueue(stream: CommandOutputStream, bytes: Uint8Array): Promise<void> {
    const operation = this.tail.then(() => this.append(stream, bytes));
    this.tail = operation.catch(() => {});
    return operation;
  }

  private async flushPending(): Promise<void> {
    if (this.pending === undefined) return;
    const record: CommandOutputRecord = {
      sequence: this.recordCount,
      stream: this.pending.stream,
      bytes: this.pending.bytes,
    };
    const encoded = OrderedCommandOutput.encodeRecord(record);
    if (this.file === undefined && this.rawBytes + record.bytes.byteLength > this.inlineBytes) {
      await this.spillInlineRecords();
    }
    if (this.file === undefined) this.inlineRecords.push(record);
    else await this.file.write(encoded);
    this.hash.update(encoded.subarray(4));
    this.rawBytes += record.bytes.byteLength;
    this.recordCount += 1;
    this.pending = undefined;
  }

  private async spillInlineRecords(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.filePath = join(this.directory, `command-output-${randomUUID()}.spool`);
    this.file = await open(this.filePath, "wx", 0o600);
    for (const record of this.inlineRecords) {
      await this.file.write(OrderedCommandOutput.encodeRecord(record));
    }
    this.inlineRecords.length = 0;
  }

  static encodeRecord(record: CommandOutputRecord): Buffer {
    const header = Buffer.alloc(RECORD_HEADER_BYTES);
    header.writeUInt32BE(record.sequence, 0);
    header.writeUInt8(record.stream === "stdout" ? 0 : 1, 4);
    header.writeUInt32BE(record.bytes.byteLength, 5);
    return Buffer.concat([header, Buffer.from(record.bytes)]);
  }

  static decodeRecords(encoded: Uint8Array): CommandOutputRecord[] {
    const records: CommandOutputRecord[] = [];
    const bytes = Buffer.from(encoded);
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (bytes.byteLength - offset < RECORD_HEADER_BYTES)
        throw new Error("Truncated command output");
      const sequence = bytes.readUInt32BE(offset);
      const streamByte = bytes.readUInt8(offset + 4);
      const length = bytes.readUInt32BE(offset + 5);
      const nextOffset = offset + RECORD_HEADER_BYTES + length;
      if (streamByte > 1 || nextOffset > bytes.byteLength)
        throw new Error("Corrupt command output");
      records.push({
        sequence,
        stream: streamByte === 0 ? "stdout" : "stderr",
        bytes: bytes.subarray(offset + RECORD_HEADER_BYTES, nextOffset),
      });
      offset = nextOffset;
    }
    return records;
  }
}

export class CommandResultReplayer {
  static async replay(
    result: CommandExecutionResult,
    context: ProgramContext,
  ): Promise<never | void> {
    if (result.output === undefined) {
      for (const frame of result.frames) {
        context[frame.stream].write(Buffer.from(frame.bytesBase64, "base64"));
      }
    } else {
      for await (const record of result.output.records())
        context[record.stream].write(record.bytes);
      await result.output.dispose();
    }
    if (result.exitCode !== 0) context.exit(result.exitCode);
  }
}

export class ControlledCommandResult {
  static acceptedRequestDidNotComplete(): CommandExecutionResult {
    return ControlledCommandResult.failure(
      "Cannot answer: accepted daemon request did not complete.\n",
    );
  }

  static workspaceCapacityExceeded(): CommandExecutionResult {
    return ControlledCommandResult.failure("Cannot answer: daemon workspace capacity exceeded.\n");
  }

  static responseCapacityExceeded(): CommandExecutionResult {
    return ControlledCommandResult.failure("Cannot answer: daemon response capacity exceeded.\n");
  }

  private static failure(message: string): CommandExecutionResult {
    const bytes = Buffer.from(message);
    const encoded = OrderedCommandOutput.encodeRecord({ sequence: 0, stream: "stderr", bytes });
    return {
      output: new StoredCommandOutput(
        {
          rawBytes: bytes.byteLength,
          recordCount: 1,
          sha256: createHash("sha256").update(encoded.subarray(4)).digest("hex"),
        },
        [{ sequence: 0, stream: "stderr", bytes }],
      ),
      frames: [{ stream: "stderr", bytesBase64: bytes.toString("base64") }],
      exitCode: 1,
    };
  }
}
