export type DaemonFailurePhase =
  | "state location"
  | "endpoint create"
  | "endpoint bind"
  | "endpoint connect"
  | "process spawn"
  | "warm-up"
  | "worker"
  | "transfer";

export type DaemonFailureReason =
  | "state-write-failed"
  | "endpoint-create-failed"
  | "endpoint-bind-denied"
  | "endpoint-connect-failed"
  | "daemon-connection-reset"
  | "process-spawn-failed"
  | "startup-failed"
  | "worker-failed"
  | "transfer-failed"
  | "process-terminated"
  | "daemon-incompatible";

export interface DaemonFailure {
  readonly phase: DaemonFailurePhase;
  readonly reason: DaemonFailureReason;
  readonly timestamp: number;
  readonly osCode?: string;
}

export interface DaemonFailureEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly workspaceRoot: string;
  readonly instanceId?: string;
  readonly requestId?: string;
  readonly kind: "startup-failure" | "fallback" | "termination";
  readonly failure: DaemonFailure;
}

export interface DaemonFallbackSummary {
  readonly count: number;
  readonly latest: DaemonFailure;
}

export interface DaemonStartupFailureStatus {
  readonly workspaceRoot: string;
  readonly failure: DaemonFailure;
}
