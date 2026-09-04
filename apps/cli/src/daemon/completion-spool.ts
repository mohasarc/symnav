import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonPolicyValues } from "@symnav/daemon";
import {
  OrderedCommandOutput,
  type CommandOutputRecord,
  type CommandOutputSummary,
} from "../command-execution-result.js";

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
  readonly policy: DaemonPolicyValues["output"];
  readonly storage?: CompletionSpoolStorage;
}

export interface CompletionSpoolFile {
  write(bytes: Uint8Array): Promise<unknown>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface CompletionSpoolStorage {
  ensureDirectory(path: string): Promise<void>;
  createFile(path: string): Promise<CompletionSpoolFile>;
  records(path: string, maximumChunkBytes: number): AsyncIterable<CommandOutputRecord>;
  unlink(path: string): Promise<void>;
  removeInstance(path: string): Promise<void>;
}

export class NodeCompletionSpoolStorage implements CompletionSpoolStorage {
  async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Completion spool directory is unsafe");
    }
    await chmod(path, 0o700);
  }

  createFile(path: string): Promise<CompletionSpoolFile> {
    return open(path, "wx", 0o600);
  }

  records(path: string, maximumChunkBytes: number): AsyncIterable<CommandOutputRecord> {
    return OrderedCommandOutput.decodeFileRecords(path, maximumChunkBytes);
  }

  async unlink(path: string): Promise<void> {
    await unlink(path);
  }

  async removeInstance(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }
}

interface CompletionSpoolOptions {
  readonly directory: string;
  readonly identity: CompletionSpoolIdentity;
  readonly requestId: string;
  readonly inlineBytes: number;
  readonly maximumResultBytes: number;
  readonly maximumChunkBytes: number;
  readonly reserve: (bytes: number) => void;
  readonly release: (bytes: number) => void;
  readonly complete: () => void;
  readonly remove: () => void;
  readonly releaseCompletion: () => void;
  readonly cleanupComplete: () => void;
  readonly storage: CompletionSpoolStorage;
}

export class CompletionSpoolCapacityError extends Error {
  constructor() {
    super("Daemon completion spool capacity exceeded");
    this.name = "CompletionSpoolCapacityError";
  }
}

export class CompletionSpoolReadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "CompletionSpoolReadError";
  }
}

export class CompletionSpool {
  private readonly hash = createHash("sha256");
  private readonly inlineRecords: CommandOutputRecord[] = [];
  private file: CompletionSpoolFile | undefined;
  private filePath: string | undefined;
  private rawBytes = 0;
  private recordCount = 0;
  private terminal = false;
  private ownershipReleased = false;
  private cleanupFinished = false;
  private disposal: Promise<void> | undefined;
  private manifest: CompletionSpoolManifest | undefined;

  constructor(private readonly options: CompletionSpoolOptions) {}

  get completedManifest(): CompletionSpoolManifest | undefined {
    return this.manifest;
  }

  async append(record: CommandOutputRecord): Promise<void> {
    if (this.terminal) throw new Error("Completion spool is already terminal");
    if (record.sequence !== this.recordCount) throw new Error("Unexpected command output sequence");
    if (record.bytes.byteLength > this.options.maximumChunkBytes) {
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
    try {
      await this.file?.sync();
      await this.closeFile();
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
    } catch (error) {
      this.terminal = true;
      return this.disposeAfterFailure(error);
    }
  }

  async *read(offset: number): AsyncIterable<CommandOutputRecord> {
    if (!this.terminal || this.manifest === undefined) {
      throw new Error("Completion spool is not complete");
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.recordCount) {
      throw new Error("Invalid completion spool offset");
    }
    try {
      const records =
        this.filePath === undefined
          ? this.inlineRecords
          : this.options.storage.records(this.filePath, this.options.maximumChunkBytes);
      for await (const record of records) {
        if (record.sequence >= offset) yield record;
      }
    } catch (error) {
      throw new CompletionSpoolReadError(error);
    }
  }

  async acknowledge(): Promise<void> {
    if (!this.terminal) throw new Error("Completion spool is not complete");
    await this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.cleanupFinished) return;
    if (this.disposal !== undefined) return this.disposal;
    this.disposal = this.performDispose();
    try {
      await this.disposal;
    } finally {
      this.disposal = undefined;
    }
  }

  private async failCapacity(): Promise<never> {
    await this.dispose();
    throw new CompletionSpoolCapacityError();
  }

  private async spillInlineRecords(): Promise<void> {
    const instanceDirectory = join(this.options.directory, this.options.identity.instanceId);
    await this.options.storage.ensureDirectory(this.options.directory);
    await this.options.storage.ensureDirectory(instanceDirectory);
    this.filePath = join(instanceDirectory, `${this.options.identity.transferId}.spool`);
    this.file = await this.options.storage.createFile(this.filePath);
    for (const record of this.inlineRecords) {
      await this.file.write(OrderedCommandOutput.encodeRecord(record));
    }
    this.inlineRecords.length = 0;
  }

  private async closeFile(): Promise<void> {
    if (this.file === undefined) return;
    await this.file.close();
    this.file = undefined;
  }

  private async performDispose(): Promise<void> {
    this.terminal = true;
    let cleanupError: unknown;
    try {
      await this.closeFile();
    } catch (error) {
      cleanupError = error;
    }
    if (this.filePath !== undefined) {
      try {
        await this.options.storage.unlink(this.filePath);
        this.filePath = undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") this.filePath = undefined;
        else cleanupError ??= error;
      }
    }
    this.releaseOwnership();
    if (this.file === undefined && this.filePath === undefined) {
      this.cleanupFinished = true;
      this.options.cleanupComplete();
    }
    if (cleanupError !== undefined) throw cleanupError;
  }

  private releaseOwnership(): void {
    if (this.ownershipReleased) return;
    this.ownershipReleased = true;
    this.inlineRecords.length = 0;
    this.options.release(this.rawBytes);
    this.options.releaseCompletion();
    this.options.remove();
  }

  private async disposeAfterFailure(error: unknown): Promise<never> {
    try {
      await this.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Completion spool operation and cleanup failed",
      );
    }
    throw error;
  }
}

export class DaemonCompletionSpoolStore {
  private readonly spools = new Map<string, CompletionSpool>();
  private readonly inlineBytes: number;
  private readonly maximumResultBytes: number;
  private readonly maximumAggregateBytes: number;
  private readonly maximumChunkBytes: number;
  private readonly storage: CompletionSpoolStorage;
  private rawBytes = 0;
  private completionCount = 0;
  private readonly pendingCleanup = new Set<CompletionSpool>();

  constructor(private readonly options: DaemonCompletionSpoolStoreOptions) {
    DaemonCompletionSpoolStore.validateIdentity(options.instanceId);
    const policy = options.policy;
    this.maximumChunkBytes = policy.maximumChunkRawBytes;
    this.inlineBytes = policy.inlineRawBytes;
    this.maximumResultBytes = policy.maximumResultRawBytes;
    this.maximumAggregateBytes = policy.maximumAggregateSpoolRawBytes;
    this.storage = options.storage ?? new NodeCompletionSpoolStorage();
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
      maximumChunkBytes: this.maximumChunkBytes,
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
      },
      releaseCompletion: () => {
        if (completionCounted) this.completionCount -= 1;
        completionCounted = false;
      },
      cleanupComplete: () => {
        this.pendingCleanup.delete(spool);
      },
      storage: this.storage,
    });
    this.spools.set(requestId, spool);
    this.pendingCleanup.add(spool);
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
    const failures: unknown[] = [];
    for (const spool of [...this.pendingCleanup]) {
      await spool.dispose().catch((error) => failures.push(error));
    }
    await this.storage
      .removeInstance(join(this.options.directory, instanceId))
      .catch((error) => failures.push(error));
    if (failures.length > 0) throw new AggregateError(failures, "Completion spool cleanup failed");
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
