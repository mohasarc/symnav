import type { DaemonTestingDiagnosticEvent } from "@symnav/daemon/testing";

export class DaemonDiagnosticEvidence {
  private static readonly closedValues: Readonly<Record<string, readonly string[]>> = {
    kind: [
      "start",
      "ready",
      "stop",
      "failure",
      "shutdown",
      "process-termination",
      "startup-failure",
      "fallback",
      "termination",
      "request-accepted",
      "turn-started",
      "worker-completed",
      "execution-terminal",
      "delivery-terminal",
      "resources-released",
      "worker-replaced",
      "startup-completed",
    ],
    terminationReason: ["uncaught-exception", "unhandled-rejection", "signal"],
    signal: ["SIGTERM", "SIGINT", "SIGHUP"],
    errorName: [
      "Error",
      "TypeError",
      "RangeError",
      "SyntaxError",
      "ReferenceError",
      "DaemonNavigationWorkerExitedError",
      "CompletionSpoolCapacityError",
      "CompletionSpoolReadError",
      "UnknownError",
    ],
    operation: [
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
    ],
    command: ["version", "overview", "resolve", "def", "refs", "context", "graph", "stats"],
    outcome: ["completed", "failed", "delivered", "disconnected"],
    reason: [
      "graceful",
      "idle",
      "resource",
      "workspace-deleted",
      "state-write-failed",
      "endpoint-create-failed",
      "endpoint-bind-denied",
      "endpoint-connect-failed",
      "daemon-connection-reset",
      "process-spawn-failed",
      "startup-failed",
      "worker-failed",
      "transfer-failed",
      "process-terminated",
      "daemon-incompatible",
    ],
    phase: [
      "state location",
      "endpoint create",
      "endpoint bind",
      "endpoint connect",
      "process spawn",
      "warm-up",
      "worker",
      "transfer",
    ],
    cause: ["hard-pressure", "out-of-memory", "shed-failure", "worker-exit"],
  };
  private static readonly numericFields = [
    "schemaVersion",
    "timestamp",
    "durationMs",
    "exitCode",
    "queueWaitMs",
    "serviceMs",
    "deliveryMs",
    "discoveryMs",
    "indexingMs",
    "totalMs",
    "freshnessMs",
    "navigationMs",
    "renderMs",
    "workerOutputMs",
    "spoolMs",
    "workerGeneration",
    "previousWorkerGeneration",
  ];

  public static event(event: Readonly<Record<string, unknown>>): DaemonTestingDiagnosticEvent {
    const retained: Record<string, string | number | boolean | DaemonTestingDiagnosticEvent> = {};
    for (const [field, values] of Object.entries(this.closedValues)) {
      const value = event[field];
      if (typeof value === "string" && values.includes(value)) retained[field] = value;
    }
    for (const field of this.numericFields) {
      const value = event[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        retained[field] = value;
    }
    for (const field of ["instanceId", "requestId", "eventId"]) {
      const value = event[field];
      if (
        typeof value === "string" &&
        /^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/u.test(value)
      )
        retained[field] = value;
    }
    const osCode = this.osCode(event.osCode);
    if (osCode !== undefined) retained.osCode = osCode;
    if (typeof event.force === "boolean") retained.force = event.force;
    if (
      typeof event.failure === "object" &&
      event.failure !== null &&
      !Array.isArray(event.failure)
    ) {
      const failure = event.failure as Record<string, unknown>;
      retained.failure = this.event({
        phase: failure.phase,
        reason: failure.reason,
        timestamp: failure.timestamp,
        osCode: failure.osCode,
      });
    }
    return retained;
  }

  public static osCode(value: unknown): string | undefined {
    return typeof value === "string" && /^(?:E[A-Z0-9_]{1,63}|ERR_[A-Z0-9_]{1,60})$/u.test(value)
      ? value
      : undefined;
  }
}
