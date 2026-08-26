import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rm, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  OrderedCommandOutput,
  type CommandOutputRecord,
  type CommandOutputSummary,
} from "../command-execution-result.js";

export const COMMAND_OUTPUT_CHUNK_BYTES = 64 * 1024;
export const DAEMON_MAXIMUM_CONTROL_FRAME_BYTES = 256 * 1024;
export const COMMAND_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;
export const DAEMON_COMPLETION_SPOOL_LIMIT_BYTES = 512 * 1024 * 1024;
export const COMPLETION_SPOOL_INLINE_BYTES = 256 * 1024;

export interface CompletionSpoolIdentity {
  readonly workspaceKey: string;
  readonly instanceId: string;
  readonly transferId: string;
}

export interface CompletionSpoolManifest extends CommandOutputSummary {
  readonly transferId: string;
  readonly requestId: string;
  readonly instanceId: string;
  readonly exitCode: number;
}

export interface CompletionSpoolUsage {
  readonly rawBytes: number;
  readonly completionCount: number;
}

export interface DaemonCompletionSpoolStoreOptions {
  readonly directory: string;
  readonly workspaceKey: string;
  readonly instanceId: string;
  readonly inlineBytes?: number;
  readonly maximumResultBytes?: number;
  readonly maximumAggregateBytes?: number;
}

interface CompletionSpoolOptions {
  readonly directory: string;
  readonly identity: CompletionSpoolIdentity;
  readonly requestId: string;
  readonly inlineBytes: number;
  readonly maximumResultBytes: number;
  readonly reserve: (bytes: number) => void;
  readonly release: (bytes: number) => void;
  readonly complete: () => void;
  readonly remove: () => void;
}

export class CompletionSpoolCapacityError extends Error {
  constructor() {
    super("Daemon completion spool capacity exceeded");
    this.name = "CompletionSpoolCapacityError";
  }
}

export class CompletionSpool {
  private readonly hash = createHash("sha256");
  private readonly inlineRecords: CommandOutputRecord[] = [];
  private file: FileHandle | undefined;
  private filePath: string | undefined;
  private rawBytes = 0;
  private recordCount = 0;
  private terminal = false;
  private removed = false;
  private manifest: CompletionSpoolManifest | undefined;

  constructor(private readonly options: CompletionSpoolOptions) {}

  get completedManifest(): CompletionSpoolManifest | undefined {
    return this.manifest;
  }

  async append(record: CommandOutputRecord): Promise<void> {
    if (this.terminal) throw new Error("Completion spool is already terminal");
    if (record.sequence !== this.recordCount) throw new Error("Unexpected command output sequence");
    if (record.bytes.byteLength > COMMAND_OUTPUT_CHUNK_BYTES) {
      throw new Error("Command output record exceeds chunk capacity");
    }
    if (this.rawBytes + record.bytes.byteLength > this.options.maximumResultBytes) {
      await this.failCapacity();
    }
    let currentRecordReserved = false;
    try {
      this.options.reserve(record.bytes.byteLength);
      currentRecordReserved = true;
      const stored: CommandOutputRecord = { ...record, bytes: Buffer.from(record.bytes) };
      if (
        this.file === undefined &&
        this.rawBytes + stored.bytes.byteLength > this.options.inlineBytes
      ) {
        await this.spillInlineRecords();
      }
      const encoded = OrderedCommandOutput.encodeRecord(stored);
      if (this.file === undefined) this.inlineRecords.push(stored);
      else await this.file.write(encoded);
      this.hash.update(encoded.subarray(4));
      this.rawBytes += stored.bytes.byteLength;
      this.recordCount += 1;
    } catch (error) {
      if (currentRecordReserved) this.options.release(record.bytes.byteLength);
      await this.dispose();
      throw error;
    }
  }

  async finish(exitCode: number): Promise<CompletionSpoolManifest> {
    if (this.terminal) throw new Error("Completion spool is already terminal");
    if (!Number.isSafeInteger(exitCode) || exitCode < 0)
      throw new Error("Invalid command exit code");
    await this.file?.sync();
    await this.file?.close();
    this.file = undefined;
    this.terminal = true;
    this.manifest = {
      transferId: this.options.identity.transferId,
      requestId: this.options.requestId,
      instanceId: this.options.identity.instanceId,
      exitCode,
      rawBytes: this.rawBytes,
      recordCount: this.recordCount,
      sha256: this.hash.digest("hex"),
    };
    this.options.complete();
    return this.manifest;
  }

  async *read(offset: number): AsyncIterable<CommandOutputRecord> {
    if (!this.terminal || this.manifest === undefined) {
      throw new Error("Completion spool is not complete");
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.recordCount) {
      throw new Error("Invalid completion spool offset");
    }
    const records =
      this.filePath === undefined
        ? this.inlineRecords
        : OrderedCommandOutput.decodeFileRecords(this.filePath);
    for await (const record of records) {
      if (record.sequence >= offset) yield record;
    }
  }

  async acknowledge(): Promise<void> {
    if (!this.terminal) throw new Error("Completion spool is not complete");
    await this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.removed) return;
    this.removed = true;
    await this.file?.close();
    this.file = undefined;
    if (this.filePath !== undefined) {
      await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    this.inlineRecords.length = 0;
    this.options.release(this.rawBytes);
    this.options.remove();
  }

  private async failCapacity(): Promise<never> {
    await this.dispose();
    throw new CompletionSpoolCapacityError();
  }

  private async spillInlineRecords(): Promise<void> {
    const instanceDirectory = join(this.options.directory, this.options.identity.instanceId);
    await CompletionSpool.ensureDirectory(this.options.directory);
    await CompletionSpool.ensureDirectory(instanceDirectory);
    this.filePath = join(instanceDirectory, `${this.options.identity.transferId}.spool`);
    this.file = await open(this.filePath, "wx", 0o600);
    for (const record of this.inlineRecords) {
      await this.file.write(OrderedCommandOutput.encodeRecord(record));
    }
    this.inlineRecords.length = 0;
  }

  private static async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Completion spool directory is unsafe");
    }
    await chmod(path, 0o700);
  }
}

export class DaemonCompletionSpoolStore {
  private readonly spools = new Map<string, CompletionSpool>();
  private readonly inlineBytes: number;
  private readonly maximumResultBytes: number;
  private readonly maximumAggregateBytes: number;
  private rawBytes = 0;
  private completionCount = 0;

  constructor(private readonly options: DaemonCompletionSpoolStoreOptions) {
    DaemonCompletionSpoolStore.validateIdentity(options.instanceId);
    this.inlineBytes = options.inlineBytes ?? COMPLETION_SPOOL_INLINE_BYTES;
    this.maximumResultBytes = options.maximumResultBytes ?? COMMAND_OUTPUT_LIMIT_BYTES;
    this.maximumAggregateBytes =
      options.maximumAggregateBytes ?? DAEMON_COMPLETION_SPOOL_LIMIT_BYTES;
  }

  async create(requestId: string): Promise<CompletionSpool> {
    if (this.spools.has(requestId))
      throw new Error(`Completion spool already exists: ${requestId}`);
    let completionCounted = false;
    const spool = new CompletionSpool({
      directory: this.options.directory,
      identity: {
        workspaceKey: this.options.workspaceKey,
        instanceId: this.options.instanceId,
        transferId: randomUUID(),
      },
      requestId,
      inlineBytes: this.inlineBytes,
      maximumResultBytes: this.maximumResultBytes,
      reserve: (bytes) => this.reserve(bytes),
      release: (bytes) => {
        this.rawBytes -= bytes;
      },
      complete: () => {
        completionCounted = true;
        this.completionCount += 1;
      },
      remove: () => {
        if (this.spools.get(requestId) !== spool) return;
        this.spools.delete(requestId);
        if (completionCounted) this.completionCount -= 1;
      },
    });
    this.spools.set(requestId, spool);
    return spool;
  }

  async open(requestId: string): Promise<CompletionSpool | undefined> {
    return this.spools.get(requestId);
  }

  usage(): CompletionSpoolUsage {
    return { rawBytes: this.rawBytes, completionCount: this.completionCount };
  }

  async cleanupInstance(instanceId: string): Promise<void> {
    if (instanceId !== this.options.instanceId) return;
    for (const spool of [...this.spools.values()]) await spool.dispose();
    await rm(join(this.options.directory, instanceId), { recursive: true, force: true });
  }

  async cleanupConfirmedDeadInstance(instanceId: string): Promise<void> {
    await this.cleanupInstance(instanceId);
  }

  private reserve(bytes: number): void {
    if (this.rawBytes + bytes > this.maximumAggregateBytes) {
      throw new CompletionSpoolCapacityError();
    }
    this.rawBytes += bytes;
  }

  private static validateIdentity(instanceId: string): void {
    if (!/^[A-Za-z\d_-]+$/.test(instanceId)) throw new Error("Invalid completion spool instance");
  }
}
