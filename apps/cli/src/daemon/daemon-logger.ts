import { chmod, mkdir, open, rename, rm, stat, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DaemonClock } from "./daemon-clock.js";
import {
  DAEMON_DIAGNOSTIC_SCHEMA_VERSION,
  type DaemonCommandName,
  type DaemonDiagnosticErrorName,
  type DaemonDiagnosticEvent,
} from "./daemon-protocol.js";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

const DIAGNOSTIC_FIELDS = [
  "schemaVersion",
  "timestamp",
  "instanceId",
  "workspaceKey",
  "kind",
  "requestId",
  "command",
  "queueDepth",
  "queuePosition",
  "workerGeneration",
  "previousWorkerGeneration",
  "queueWaitMs",
  "freshnessMs",
  "navigationMs",
  "renderMs",
  "workerOutputMs",
  "added",
  "changed",
  "removed",
  "unchanged",
  "rawBytes",
  "recordCount",
  "spoolMs",
  "outcome",
  "serviceMs",
  "deliveryMs",
  "processRssBytes",
  "workerHeapUsedBytes",
  "workerHeapLimitBytes",
  "spoolBytes",
  "fileCount",
  "discoveryMs",
  "indexingMs",
  "totalMs",
  "durationMs",
  "exitCode",
  "reason",
  "cause",
  "force",
  "operation",
  "failureCode",
  "errorName",
  "droppedCount",
] as const;

const DIAGNOSTIC_KINDS = new Set([
  "start",
  "ready",
  "acceptance",
  "request",
  "freshness",
  "stop",
  "failure",
  "request-accepted",
  "turn-started",
  "worker-completed",
  "response-spooled",
  "execution-terminal",
  "client-disconnected",
  "client-reattached",
  "delivery-terminal",
  "diagnostics-dropped",
  "startup-completed",
  "resources-released",
  "worker-replaced",
  "shutdown",
]);

const COMMAND_NAMES = new Set<DaemonCommandName>([
  "overview",
  "resolve",
  "def",
  "refs",
  "context",
  "graph",
  "stats",
  "help",
  "version",
  "unknown",
]);

const ERROR_NAMES = new Set<DaemonDiagnosticErrorName>([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "DaemonNavigationWorkerExitedError",
  "CompletionSpoolCapacityError",
  "CompletionSpoolReadError",
  "UnknownError",
]);

export const DAEMON_LOG_ROTATE_BYTES = 10 * 1024 * 1024;
export const DAEMON_LOG_BACKUP_COUNT = 4;

export interface DaemonLogStorage {
  prepare(directory: string, logPath: string): Promise<void>;
  size(path: string): Promise<number>;
  append(path: string, line: string): Promise<void>;
  move(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
  sync(path: string): Promise<void>;
}

interface DaemonLoggerOptions {
  readonly rotateBytes?: number;
  readonly maximumQueuedEvents?: number;
  readonly storage?: DaemonLogStorage;
}

class NodeDaemonLogStorage implements DaemonLogStorage {
  async prepare(directory: string, logPath: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await appendFile(logPath, "", { encoding: "utf8", flag: "a", mode: 0o600 });
    await chmod(logPath, 0o600);
  }

  async size(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (NodeDaemonLogStorage.errorCode(error) === "ENOENT") return 0;
      throw error;
    }
  }

  append(path: string, line: string): Promise<void> {
    return appendFile(path, line, { encoding: "utf8", flag: "a", mode: 0o600 });
  }

  async move(source: string, destination: string): Promise<void> {
    try {
      await rename(source, destination);
    } catch (error) {
      if (NodeDaemonLogStorage.errorCode(error) !== "ENOENT") throw error;
    }
  }

  remove(path: string): Promise<void> {
    return rm(path, { force: true });
  }

  async sync(path: string): Promise<void> {
    let file;
    try {
      file = await open(path, "r");
      await file.sync();
    } catch (error) {
      if (NodeDaemonLogStorage.errorCode(error) !== "ENOENT") throw error;
    } finally {
      await file?.close();
    }
  }

  private static errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
  }
}

export class DaemonLogger {
  private readonly rotateBytes: number;
  private readonly maximumQueuedEvents: number;
  private readonly storage: DaemonLogStorage;
  private readonly pendingLines: string[] = [];
  private droppedCount = 0;
  private drainOperation: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly identity: DaemonWorkspaceIdentity,
    private readonly instanceId: string,
    private readonly clock: DaemonClock,
    options: DaemonLoggerOptions = {},
  ) {
    this.rotateBytes = options.rotateBytes ?? DAEMON_LOG_ROTATE_BYTES;
    this.maximumQueuedEvents = options.maximumQueuedEvents ?? 1_024;
    this.storage = options.storage ?? new NodeDaemonLogStorage();
  }

  record(event: DaemonDiagnosticEvent): void {
    try {
      if (this.closed) return;
      const line = this.serialize(event);
      if (line === undefined) return;
      if (this.pendingLines.length >= this.maximumQueuedEvents) {
        this.droppedCount += 1;
        return;
      }
      this.pendingLines.push(line);
      this.startDrain();
    } catch {
      return;
    }
  }

  async flush(): Promise<void> {
    while (
      this.drainOperation !== undefined ||
      this.pendingLines.length > 0 ||
      this.droppedCount > 0
    ) {
      this.startDrain();
      await this.drainOperation;
    }
    await this.storage.sync(this.identity.logPath).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  static errorName(error: unknown): DaemonDiagnosticErrorName {
    const name =
      error instanceof Error
        ? error.name
        : typeof error === "object" && error !== null && "name" in error
          ? error.name
          : undefined;
    return ERROR_NAMES.has(name as DaemonDiagnosticErrorName)
      ? (name as DaemonDiagnosticErrorName)
      : "UnknownError";
  }

  private static closedEvent(event: DaemonDiagnosticEvent): Record<string, unknown> | undefined {
    const diagnostic = event as unknown as Record<string, unknown>;
    if (!DIAGNOSTIC_KINDS.has(String(diagnostic.kind))) return undefined;
    const closed = { ...diagnostic };
    if ("command" in closed && !COMMAND_NAMES.has(closed.command as DaemonCommandName)) {
      closed.command = "unknown";
    }
    if ("errorName" in closed && !ERROR_NAMES.has(closed.errorName as DaemonDiagnosticErrorName)) {
      closed.errorName = "UnknownError";
    }
    return closed;
  }

  private serialize(event: DaemonDiagnosticEvent): string | undefined {
    const diagnostic = DaemonLogger.closedEvent(event);
    if (diagnostic === undefined) return undefined;
    return `${JSON.stringify(
      {
        ...diagnostic,
        schemaVersion: DAEMON_DIAGNOSTIC_SCHEMA_VERSION,
        timestamp: this.clock.wallNowMs(),
        instanceId: this.instanceId,
        workspaceKey: this.identity.workspaceKey,
      },
      [...DIAGNOSTIC_FIELDS],
    )}\n`;
  }

  private startDrain(): void {
    if (this.drainOperation !== undefined) return;
    const operation = this.drain();
    this.drainOperation = operation.finally(() => {
      this.drainOperation = undefined;
      if (this.pendingLines.length > 0 || this.droppedCount > 0) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    const logDirectory = dirname(this.identity.logPath);
    let currentBytes: number;
    try {
      await this.storage.prepare(logDirectory, this.identity.logPath);
      currentBytes = await this.storage.size(this.identity.logPath);
    } catch {
      this.pendingLines.length = 0;
      this.droppedCount = 0;
      return;
    }
    while (this.pendingLines.length > 0 || this.droppedCount > 0) {
      if (this.pendingLines.length === 0) {
        const droppedCount = this.droppedCount;
        this.droppedCount = 0;
        const dropped = this.serialize({ kind: "diagnostics-dropped", droppedCount });
        if (dropped !== undefined) this.pendingLines.push(dropped);
      }
      const line = this.pendingLines.shift();
      if (line === undefined) continue;
      const lineBytes = Buffer.byteLength(line);
      try {
        if (currentBytes + lineBytes > this.rotateBytes) {
          await this.rotate();
          await this.storage.prepare(logDirectory, this.identity.logPath);
          currentBytes = 0;
        }
        await this.storage.append(this.identity.logPath, line);
        currentBytes += lineBytes;
      } catch {
        continue;
      }
    }
  }

  private async rotate(): Promise<void> {
    await this.storage.remove(`${this.identity.logPath}.${DAEMON_LOG_BACKUP_COUNT}`);
    for (let index = DAEMON_LOG_BACKUP_COUNT - 1; index >= 1; index -= 1) {
      await this.storage.move(
        `${this.identity.logPath}.${index}`,
        `${this.identity.logPath}.${index + 1}`,
      );
    }
    await this.storage.move(this.identity.logPath, `${this.identity.logPath}.1`);
  }
}
