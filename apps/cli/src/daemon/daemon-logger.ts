import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
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
  "spoolBytes",
  "fileCount",
  "durationMs",
  "exitCode",
  "reason",
  "operation",
  "failureCode",
  "errorName",
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

export class DaemonLogger {
  constructor(
    private readonly identity: DaemonWorkspaceIdentity,
    private readonly instanceId: string,
    private readonly clock: DaemonClock,
  ) {}

  record(event: DaemonDiagnosticEvent): void {
    try {
      const diagnostic = DaemonLogger.closedEvent(event);
      if (diagnostic === undefined) return;
      const logDirectory = dirname(this.identity.logPath);
      mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
      chmodSync(logDirectory, 0o700);
      const serialized = JSON.stringify(
        {
          ...diagnostic,
          schemaVersion: DAEMON_DIAGNOSTIC_SCHEMA_VERSION,
          timestamp: this.clock.wallNowMs(),
          instanceId: this.instanceId,
          workspaceKey: this.identity.workspaceKey,
        },
        [...DIAGNOSTIC_FIELDS],
      );
      appendFileSync(this.identity.logPath, `${serialized}\n`, {
        encoding: "utf8",
        flag: "a",
        mode: 0o600,
      });
      chmodSync(this.identity.logPath, 0o600);
    } catch {
      return;
    }
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return this.flush();
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
}
