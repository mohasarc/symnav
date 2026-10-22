const executionFailureCodes = [
  "worker-exit",
  "controlled-resource",
  "response-capacity",
  "stopping",
  "internal",
] as const;

export type DaemonExecutionFailureCode = (typeof executionFailureCodes)[number];

export type DaemonWorkerFailureCode = "initialization" | "execution" | "protocol" | "resource";

export interface DaemonExecutionFailureContext {
  readonly resourceInterrupted: boolean;
  readonly responseCapacityExceeded: boolean;
  readonly workerExited: boolean;
  readonly shutdownFailureCode?: "stopping" | "controlled-resource";
  readonly shutdownStarted: boolean;
}

export class DaemonExecutionFailures {
  static isCode(value: unknown): value is DaemonExecutionFailureCode {
    return executionFailureCodes.includes(value as DaemonExecutionFailureCode);
  }

  static classify(context: DaemonExecutionFailureContext): DaemonExecutionFailureCode {
    if (context.resourceInterrupted) return "controlled-resource";
    if (context.responseCapacityExceeded) return "response-capacity";
    if (context.workerExited) {
      return context.shutdownFailureCode === "stopping" ? "stopping" : "worker-exit";
    }
    if (context.shutdownFailureCode !== undefined) return context.shutdownFailureCode;
    return context.shutdownStarted ? "stopping" : "internal";
  }
}
