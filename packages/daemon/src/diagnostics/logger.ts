import { chmod, mkdir, open, rename, rm, stat, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DaemonExecutionFailures, type DaemonPolicyValues } from "@symnav/daemon";
import type { DaemonClock } from "../lifecycle/daemon-clock.js";
import {
  DAEMON_DIAGNOSTIC_SCHEMA_VERSION,
  type DaemonDiagnosticErrorName,
  type DaemonDiagnosticEvent,
} from "../transport/protocol.js";
import { DaemonRuntimeValues } from "../process/runtime-values.js";
import type { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";

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
  "peakProcessRssBytes",
  "peakWorkerHeapUsedBytes",
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
  "terminationReason",
  "signal",
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
  "operation-trace-expired",
  "delivery-terminal",
  "diagnostics-dropped",
  "startup-completed",
  "resources-released",
  "worker-replaced",
  "shutdown",
  "process-termination",
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

const CLOSED_DIAGNOSTIC_VALUES = new Map<string, ReadonlySet<string>>([
  [
    "operation",
    new Set([
      "start",
      "request",
      "resource-sample",
      "resource-drain",
      "worker-exit",
      "worker-replacement",
      "completion-delivery",
      "completion-cleanup",
      "transport-close",
      "diagnostics-write",
      "diagnostics-rotation",
    ]),
  ],
  ["outcome", new Set(["completed", "failed", "delivered", "disconnected"])],
  ["reason", new Set(["graceful", "idle", "resource", "workspace-deleted"])],
  ["cause", new Set(["hard-pressure", "out-of-memory", "shed-failure", "worker-exit"])],
  ["terminationReason", new Set(["uncaught-exception", "unhandled-rejection", "signal"])],
  ["signal", new Set(["SIGTERM", "SIGINT", "SIGHUP"])],
]);

const NUMERIC_DIAGNOSTIC_FIELDS = new Set([
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
  "serviceMs",
  "deliveryMs",
  "processRssBytes",
  "peakProcessRssBytes",
  "peakWorkerHeapUsedBytes",
  "workerHeapUsedBytes",
  "workerHeapLimitBytes",
  "spoolBytes",
  "fileCount",
  "discoveryMs",
  "indexingMs",
  "totalMs",
  "durationMs",
  "exitCode",
  "droppedCount",
]);

export interface DaemonLogStorage {
  prepare(directory: string, logPath: string): Promise<void>;
  size(path: string): Promise<number>;
  append(path: string, line: string): Promise<void>;
  move(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
  sync(path: string): Promise<void>;
}

interface DaemonLoggerOptions {
  readonly policy: DaemonPolicyValues["diagnostics"];
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
  private readonly backupCount: number;
  private readonly storage: DaemonLogStorage;
  private readonly pendingLines: string[] = [];
  private droppedCount = 0;
  private drainOperation: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly identity: DaemonWorkspaceIdentity,
    private readonly instanceId: string,
    private readonly clock: DaemonClock,
    options: DaemonLoggerOptions,
  ) {
    const policy = options.policy;
    this.rotateBytes = policy.logRotateBytes;
    this.maximumQueuedEvents = policy.maximumQueuedEvents;
    this.backupCount = policy.logBackupCount;
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
    const closed: Record<string, unknown> = { ...diagnostic };
    if ("command" in closed && !DaemonRuntimeValues.isCommandName(closed.command)) {
      closed.command = "unknown";
    }
    if ("errorName" in closed && !ERROR_NAMES.has(closed.errorName as DaemonDiagnosticErrorName)) {
      closed.errorName = "UnknownError";
    }
    if (
      "failureCode" in closed &&
      closed.failureCode !== "operation-failed" &&
      !DaemonExecutionFailures.isCode(closed.failureCode)
    ) {
      return undefined;
    }
    for (const [field, values] of CLOSED_DIAGNOSTIC_VALUES) {
      if (field in closed && !values.has(String(closed[field]))) return undefined;
    }
    for (const field of NUMERIC_DIAGNOSTIC_FIELDS) {
      if (!(field in closed)) continue;
      const value = closed[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    }
    if ("force" in closed && typeof closed.force !== "boolean") return undefined;
    if (closed.kind === "process-termination") {
      const isSignal = closed.terminationReason === "signal";
      if (isSignal !== (closed.signal !== undefined)) return undefined;
      if (isSignal === (closed.errorName !== undefined)) return undefined;
    }
    return closed;
  }

  private serialize(event: DaemonDiagnosticEvent): string | undefined {
    const diagnostic = DaemonLogger.closedEvent(event);
    if (diagnostic === undefined) return undefined;
    if ("requestId" in diagnostic) {
      if (typeof diagnostic.requestId !== "string") return undefined;
      diagnostic.requestId = this.requestCorrelation(diagnostic.requestId);
    }
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

  private requestCorrelation(requestId: string): string {
    return createHash("sha256")
      .update(this.identity.workspaceKey)
      .update("\0")
      .update(requestId)
      .digest("hex");
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
    await this.storage.remove(`${this.identity.logPath}.${this.backupCount}`);
    for (let index = this.backupCount - 1; index >= 1; index -= 1) {
      await this.storage.move(
        `${this.identity.logPath}.${index}`,
        `${this.identity.logPath}.${index + 1}`,
      );
    }
    await this.storage.move(this.identity.logPath, `${this.identity.logPath}.1`);
  }
}
