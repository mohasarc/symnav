import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DaemonExecutorExecutionResult,
  DaemonExecutorOutput,
  DaemonOutputRecord,
  DaemonPolicyValues,
  DaemonSequencedOutputRecord,
} from "@symnav/daemon";

const RECORD_HEADER_BYTES = 9;

export interface DaemonOutputCapture {
  append(record: DaemonSequencedOutputRecord): Promise<void>;
  finish(exitCode: number): Promise<DaemonCapturedOutput>;
  dispose(): Promise<void>;
}

export interface DaemonCapturedOutputSummary {
  readonly rawBytes: number;
  readonly recordCount: number;
  readonly sha256: string;
}

export interface DaemonCapturedOutput {
  readonly result: DaemonExecutorExecutionResult;
  readonly summary: DaemonCapturedOutputSummary;
}

export interface DaemonClientResultCaptureOptions {
  readonly directory?: string;
  readonly policy: Pick<
    DaemonPolicyValues["output"],
    "maximumChunkRawBytes" | "inlineRawBytes" | "maximumResultRawBytes"
  >;
}

export class DaemonClientResultCapture implements DaemonOutputCapture {
  private readonly directory: string;
  private readonly inlineRawBytes: number;
  private readonly maximumResultRawBytes: number;
  private readonly maximumChunkRawBytes: number;
  private readonly hash = createHash("sha256");
  private readonly inlineRecords: DaemonSequencedOutputRecord[] = [];
  private file: FileHandle | undefined;
  private filePath: string | undefined;
  private rawBytes = 0;
  private recordCount = 0;
  private finished = false;
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | undefined;

  constructor(options: DaemonClientResultCaptureOptions) {
    this.directory = options.directory ?? tmpdir();
    this.inlineRawBytes = options.policy.inlineRawBytes;
    this.maximumResultRawBytes = options.policy.maximumResultRawBytes;
    this.maximumChunkRawBytes = options.policy.maximumChunkRawBytes;
  }

  append(record: DaemonSequencedOutputRecord): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.finished) throw new Error("Command output is already finished");
      if (record.sequence !== this.recordCount) {
        throw new Error("Unexpected command output sequence");
      }
      if (record.bytes.byteLength > this.maximumChunkRawBytes) {
        throw new Error("Command output record exceeds chunk capacity");
      }
      if (this.rawBytes + record.bytes.byteLength > this.maximumResultRawBytes) {
        throw new DaemonClientResultCapacityError();
      }
      await this.storeRecord({ ...record, bytes: Buffer.from(record.bytes) });
    });
    this.tail = operation.catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
    });
    return operation;
  }

  async finish(exitCode: number): Promise<DaemonCapturedOutput> {
    if (this.finished) throw new Error("Command output is already finished");
    await this.tail;
    if (this.failure !== undefined) throw this.failure;
    this.finished = true;
    await this.file?.close();
    this.file = undefined;
    const summary: DaemonCapturedOutputSummary = {
      rawBytes: this.rawBytes,
      recordCount: this.recordCount,
      sha256: this.hash.digest("hex"),
    };
    return {
      result: {
        exitCode,
        output: new DaemonStoredExecutorOutput(
          [...this.inlineRecords],
          this.filePath,
          this.maximumChunkRawBytes,
        ),
      },
      summary,
    };
  }

  async dispose(): Promise<void> {
    await this.file?.close();
    this.file = undefined;
    if (this.filePath === undefined) return;
    await DaemonClientResultCapture.remove(this.filePath);
    this.filePath = undefined;
  }

  private async storeRecord(record: DaemonSequencedOutputRecord): Promise<void> {
    const encoded = DaemonClientResultCapture.encodeRecord(record);
    if (this.file === undefined && this.rawBytes + record.bytes.byteLength > this.inlineRawBytes) {
      await this.spillInlineRecords();
    }
    if (this.file === undefined) this.inlineRecords.push(record);
    else await this.file.write(encoded);
    this.hash.update(encoded.subarray(4));
    this.rawBytes += record.bytes.byteLength;
    this.recordCount += 1;
  }

  private async spillInlineRecords(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.filePath = join(this.directory, `command-output-${randomUUID()}.spool`);
    this.file = await open(this.filePath, "wx", 0o600);
    for (const record of this.inlineRecords) {
      await this.file.write(DaemonClientResultCapture.encodeRecord(record));
    }
    this.inlineRecords.length = 0;
  }

  private static encodeRecord(record: DaemonSequencedOutputRecord): Buffer {
    const header = Buffer.alloc(RECORD_HEADER_BYTES);
    header.writeUInt32BE(record.sequence, 0);
    header.writeUInt8(record.stream === "stdout" ? 0 : 1, 4);
    header.writeUInt32BE(record.bytes.byteLength, 5);
    return Buffer.concat([header, Buffer.from(record.bytes)]);
  }

  private static async remove(filePath: string): Promise<void> {
    await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

class DaemonClientResultCapacityError extends Error {
  constructor() {
    super("Command output exceeds response capacity");
    this.name = "CommandOutputCapacityError";
  }
}

export class DaemonStoredExecutorOutput implements DaemonExecutorOutput {
  constructor(
    private readonly inlineRecords: readonly DaemonSequencedOutputRecord[],
    private readonly filePath?: string,
    private readonly maximumRecordBytes?: number,
  ) {}

  async *records(): AsyncIterable<DaemonOutputRecord> {
    const records =
      this.filePath === undefined
        ? this.inlineRecords
        : DaemonStoredExecutorOutput.decodeFileRecords(this.filePath, this.maximumRecordBytes!);
    for await (const record of records) yield { stream: record.stream, bytes: record.bytes };
  }

  async dispose(): Promise<void> {
    if (this.filePath === undefined) return;
    await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private static async *decodeFileRecords(
    filePath: string,
    maximumRecordBytes: number,
  ): AsyncIterable<DaemonSequencedOutputRecord> {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const handle = await open(filePath, constants.O_RDONLY | noFollow);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("Command output spool is not a regular file");
      let position = 0;
      let expectedSequence = 0;
      while (position < metadata.size) {
        const header = Buffer.alloc(RECORD_HEADER_BYTES);
        await DaemonStoredExecutorOutput.readExact(handle, header, position);
        position += RECORD_HEADER_BYTES;
        const sequence = header.readUInt32BE(0);
        const streamByte = header.readUInt8(4);
        const length = header.readUInt32BE(5);
        if (sequence !== expectedSequence || streamByte > 1 || length > maximumRecordBytes) {
          throw new Error("Corrupt command output");
        }
        const bytes = Buffer.alloc(length);
        await DaemonStoredExecutorOutput.readExact(handle, bytes, position);
        position += length;
        expectedSequence += 1;
        yield { sequence, stream: streamByte === 0 ? "stdout" : "stderr", bytes };
      }
    } finally {
      await handle.close();
    }
  }

  private static async readExact(
    handle: FileHandle,
    target: Buffer,
    position: number,
  ): Promise<void> {
    let readBytes = 0;
    while (readBytes < target.byteLength) {
      const result = await handle.read(
        target,
        readBytes,
        target.byteLength - readBytes,
        position + readBytes,
      );
      if (result.bytesRead === 0) throw new Error("Truncated command output");
      readBytes += result.bytesRead;
    }
  }
}
