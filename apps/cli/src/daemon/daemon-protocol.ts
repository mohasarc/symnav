import type { CliExecutionRequest } from "../command-execution-result.js";
import type { CompletionSpoolManifest } from "./completion-spool.js";
import type { CommandOutputStream } from "../command-execution-result.js";
import type { BackendRefreshSummary } from "@symnav/core";

export const DAEMON_PROTOCOL_VERSION = 4;
export const DAEMON_RECORD_SCHEMA_VERSION = 2;
export const DAEMON_DIAGNOSTIC_SCHEMA_VERSION = 1;

export type DaemonCommandName =
  | "overview"
  | "resolve"
  | "def"
  | "refs"
  | "context"
  | "graph"
  | "stats"
  | "help"
  | "version"
  | "unknown";

export interface DaemonIdentityCoordinates {
  readonly workspaceRoot: string;
  readonly workspaceKey: string;
  readonly stateKey: string;
  readonly identityKey: string;
  readonly instanceId: string;
  readonly processToken: string;
  readonly endpoint: string;
}

export interface DaemonRecord extends DaemonIdentityCoordinates {
  readonly schemaVersion: number;
  readonly protocolVersion: number;
  readonly symnavVersion: string;
  readonly pid: number;
  readonly state: "starting" | "ready";
  readonly startedAt: number;
  readonly readyAt?: number;
  readonly lastNavigationAt?: number;
  readonly fileCount?: number;
  readonly memoryBytes?: number;
  readonly memoryCapBytes: number;
}

export type WorkspaceRequestQueueState = "accepting" | "draining" | "closed";

export interface DaemonActivitySnapshot {
  readonly lifecycle: "starting" | "ready" | "busy" | "recovering" | "draining";
  readonly recoveryDetail?: "resource-pressure" | "worker-replacement";
  readonly pid: number;
  readonly startedAt: number;
  readonly startupElapsedMs: number;
  readonly fileCount?: number;
  readonly processRssBytes: number;
  readonly hardProcessRssBytes: number;
  readonly workerHeapUsedBytes?: number;
  readonly workerGeneration: number;
  readonly current?: {
    readonly requestId: string;
    readonly command: DaemonCommandName;
    readonly elapsedMs: number;
  };
  readonly queued: number;
  readonly lastCompletedAgoMs?: number;
  readonly spoolBytes: number;
}

export type RunningDaemonStatus =
  | {
      readonly state: "starting";
      readonly workspaceRoot: string;
      readonly pid: number;
      readonly startupElapsedMs: number;
      readonly memoryBytes?: number;
    }
  | {
      readonly state: "ready";
      readonly workspaceRoot: string;
      readonly pid: number;
      readonly uptimeMs: number;
      readonly fileCount: number;
      readonly memoryBytes: number;
      readonly lastRequestAgoMs?: number;
    }
  | {
      readonly state: "busy";
      readonly workspaceRoot: string;
      readonly pid: number;
      readonly uptimeMs: number;
      readonly command: DaemonCommandName;
      readonly elapsedMs: number;
      readonly queued: number;
      readonly memoryBytes: number;
    }
  | {
      readonly state: "recovering";
      readonly workspaceRoot: string;
      readonly pid: number;
      readonly uptimeMs: number;
      readonly detail: "resource-pressure" | "worker-replacement" | "draining";
      readonly queued: number;
      readonly memoryBytes: number;
    }
  | {
      readonly state: "unresponsive";
      readonly workspaceRoot: string;
      readonly pid: number;
      readonly uptimeMs: number;
      readonly lastResponseAgoMs?: number;
      readonly lastKnown?: DaemonActivitySnapshot;
    };

export interface DaemonStatusEnvelope {
  readonly schemaVersion: 1;
  readonly daemons: readonly RunningDaemonStatus[];
}

export type DaemonStopResult =
  | { readonly status: "stopped"; readonly workspaceRoot: string; readonly pid: number }
  | { readonly status: "killed"; readonly workspaceRoot: string; readonly pid: number }
  | { readonly status: "not-running"; readonly workspaceRoot: string };

export type DaemonStopReason = "graceful" | "idle" | "resource" | "workspace-deleted";

export type DaemonExecutionFailureCode =
  | "worker-exit"
  | "controlled-resource"
  | "response-capacity"
  | "stopping"
  | "internal";

export type DaemonExecuteRejectionCode =
  | "not-ready"
  | "draining"
  | "resource-pressure"
  | "incompatible";

export interface DaemonExecuteRequest {
  readonly kind: "execute";
  readonly protocolVersion: number;
  readonly instanceId: string;
  readonly processToken: string;
  readonly requestId: string;
  readonly request: CliExecutionRequest;
}

export type DaemonExecutionServerFrame =
  | {
      readonly kind: "accepted";
      readonly instanceId: string;
      readonly processToken: string;
      readonly requestId: string;
      readonly acceptedAt: number;
      readonly queuePosition: number;
    }
  | {
      readonly kind: "rejected";
      readonly instanceId: string;
      readonly processToken: string;
      readonly requestId: string;
      readonly code: DaemonExecuteRejectionCode;
      readonly retrySafe: boolean;
    }
  | {
      readonly kind: "result-manifest";
      readonly instanceId: string;
      readonly processToken: string;
      readonly requestId: string;
      readonly manifest: CompletionSpoolManifest;
    }
  | {
      readonly kind: "result-end";
      readonly instanceId: string;
      readonly processToken: string;
      readonly requestId: string;
      readonly transferId: string;
      readonly rawBytes: number;
      readonly recordCount: number;
      readonly sha256: string;
    }
  | {
      readonly kind: "execution-failed";
      readonly instanceId: string;
      readonly processToken: string;
      readonly requestId: string;
      readonly code: DaemonExecutionFailureCode;
    };

export type DaemonExecutionStatus =
  | { readonly state: "unknown" }
  | { readonly state: "queued"; readonly queuePosition: number }
  | { readonly state: "running"; readonly startedAt: number }
  | { readonly state: "completed" }
  | { readonly state: "failed"; readonly code: DaemonExecutionFailureCode };

export interface DaemonExecutionStatusRequest {
  readonly kind: "execution-status";
  readonly protocolVersion: number;
  readonly instanceId: string;
  readonly processToken: string;
  readonly requestId: string;
}

export interface DaemonExecutionStatusResponse {
  readonly kind: "execution-status";
  readonly instanceId: string;
  readonly processToken: string;
  readonly requestId: string;
  readonly status: DaemonExecutionStatus;
}

export interface DaemonResultChunk {
  readonly transferId: string;
  readonly requestId: string;
  readonly offset: number;
  readonly sequence: number;
  readonly stream: CommandOutputStream;
  readonly bytes: Uint8Array;
}

export interface DaemonResultFetchRequest {
  readonly kind: "result-fetch";
  readonly protocolVersion: number;
  readonly instanceId: string;
  readonly processToken: string;
  readonly requestId: string;
  readonly offset: number;
}

export interface DaemonResultAcknowledgement {
  readonly kind: "result-ack";
  readonly protocolVersion: number;
  readonly instanceId: string;
  readonly processToken: string;
  readonly requestId: string;
  readonly transferId: string;
}

export interface DaemonWorkerPhaseDurations {
  readonly freshnessMs: number;
  readonly navigationMs: number;
  readonly renderMs: number;
  readonly workerOutputMs: number;
}

export type DaemonExecutionOutcome = "completed" | "failed";
export type DaemonDeliveryOutcome = "delivered" | "disconnected" | "failed";
export type DaemonWorkerReplacementCause =
  | "hard-pressure"
  | "out-of-memory"
  | "shed-failure"
  | "worker-exit";

export interface DaemonStartupDiagnostic {
  readonly kind: "startup-completed";
  readonly workerGeneration: number;
  readonly fileCount: number;
  readonly discoveryMs: number;
  readonly indexingMs: number;
  readonly totalMs: number;
}

export type DaemonWorkerDiagnostic =
  | {
      readonly kind: "resources-released";
      readonly workerGeneration: number;
      readonly workerHeapUsedBytes: number;
      readonly workerHeapLimitBytes: number;
    }
  | {
      readonly kind: "worker-replaced";
      readonly cause: DaemonWorkerReplacementCause;
      readonly previousWorkerGeneration: number;
      readonly workerGeneration: number;
      readonly fileCount: number;
      readonly discoveryMs: number;
      readonly indexingMs: number;
      readonly totalMs: number;
    };

export interface DaemonShutdownDiagnostic {
  readonly kind: "shutdown";
  readonly reason: DaemonStopReason;
  readonly force: boolean;
}

export type DaemonOperationDiagnostic =
  | {
      readonly kind: "request-accepted";
      readonly requestId: string;
      readonly command: DaemonCommandName;
      readonly queueDepth: number;
      readonly workerGeneration: number;
    }
  | {
      readonly kind: "turn-started";
      readonly requestId: string;
      readonly queueWaitMs: number;
      readonly workerGeneration: number;
    }
  | ({
      readonly kind: "worker-completed";
      readonly requestId: string;
    } & DaemonWorkerPhaseDurations &
      BackendRefreshSummary)
  | {
      readonly kind: "response-spooled";
      readonly requestId: string;
      readonly rawBytes: number;
      readonly recordCount: number;
      readonly spoolMs: number;
    }
  | {
      readonly kind: "execution-terminal";
      readonly requestId: string;
      readonly outcome: DaemonExecutionOutcome;
      readonly serviceMs: number;
      readonly processRssBytes?: number;
      readonly peakProcessRssBytes?: number;
      readonly workerHeapUsedBytes?: number;
      readonly spoolBytes?: number;
    }
  | { readonly kind: "client-disconnected"; readonly requestId: string }
  | { readonly kind: "client-reattached"; readonly requestId: string }
  | { readonly kind: "operation-trace-expired"; readonly requestId: string }
  | {
      readonly kind: "delivery-terminal";
      readonly requestId: string;
      readonly outcome: DaemonDeliveryOutcome;
      readonly deliveryMs: number;
    };

export type DaemonFailureOperation =
  | "start"
  | "request"
  | "resource-sample"
  | "resource-drain"
  | "worker-exit"
  | "worker-replacement"
  | "completion-delivery"
  | "completion-cleanup"
  | "transport-close"
  | "diagnostics-write"
  | "diagnostics-rotation";

export type DaemonDiagnosticErrorName =
  | "Error"
  | "TypeError"
  | "RangeError"
  | "SyntaxError"
  | "ReferenceError"
  | "DaemonNavigationWorkerExitedError"
  | "CompletionSpoolCapacityError"
  | "CompletionSpoolReadError"
  | "UnknownError";

export type DaemonDiagnosticFailureCode = DaemonExecutionFailureCode | "operation-failed";

export type DaemonDiagnosticEvent =
  | { readonly kind: "start" }
  | { readonly kind: "ready"; readonly fileCount: number }
  | { readonly kind: "acceptance"; readonly requestId: string; readonly queuePosition: number }
  | {
      readonly kind: "request";
      readonly command: DaemonCommandName;
      readonly durationMs: number;
      readonly exitCode: number;
    }
  | {
      readonly kind: "freshness";
      readonly added: number;
      readonly changed: number;
      readonly removed: number;
      readonly unchanged: number;
    }
  | { readonly kind: "stop"; readonly reason: DaemonStopReason }
  | { readonly kind: "diagnostics-dropped"; readonly droppedCount: number }
  | {
      readonly kind: "failure";
      readonly operation: DaemonFailureOperation;
      readonly failureCode: DaemonDiagnosticFailureCode;
      readonly errorName: DaemonDiagnosticErrorName;
    }
  | DaemonStartupDiagnostic
  | DaemonWorkerDiagnostic
  | DaemonShutdownDiagnostic
  | DaemonOperationDiagnostic;

export type DaemonLogEvent = DaemonDiagnosticEvent & {
  readonly schemaVersion: 1;
  readonly timestamp: number;
  readonly instanceId: string;
  readonly workspaceKey: string;
};

export type DaemonLifecycleRequest =
  | {
      readonly kind: "identify";
      readonly instanceId: string;
      readonly processToken: string;
    }
  | {
      readonly kind: "terminate";
      readonly instanceId: string;
      readonly processToken: string;
    }
  | {
      readonly kind: "kill";
      readonly instanceId: string;
      readonly processToken: string;
    }
  | { readonly kind: "ping"; readonly protocolVersion: number; readonly instanceId: string }
  | { readonly kind: "stop"; readonly protocolVersion: number; readonly instanceId: string };

export type DaemonRequest =
  | DaemonLifecycleRequest
  | DaemonExecuteRequest
  | DaemonExecutionStatusRequest
  | DaemonResultFetchRequest
  | DaemonResultAcknowledgement;

export type DaemonLifecycleResponse =
  | {
      readonly kind: "identity";
      readonly instanceId: string;
      readonly processToken: string;
      readonly pid: number;
      readonly startedAt: number;
    }
  | {
      readonly kind: "terminating";
      readonly instanceId: string;
      readonly processToken: string;
    }
  | {
      readonly kind: "killing";
      readonly instanceId: string;
      readonly processToken: string;
    }
  | {
      readonly kind: "pong";
      readonly protocolVersion: number;
      readonly instanceId: string;
      readonly symnavVersion: string;
      readonly state?: "starting" | "ready" | "busy";
      readonly startedAt?: number;
      readonly fileCount?: number;
      readonly memoryBytes?: number;
      readonly lastNavigationAt?: number;
      readonly currentCommand?: string;
      readonly currentCommandElapsedMs?: number;
      readonly queued?: number;
      readonly activity?: DaemonActivitySnapshot;
    }
  | { readonly kind: "stopped"; readonly instanceId: string };

export type DaemonResponse =
  | DaemonLifecycleResponse
  | DaemonExecutionServerFrame
  | DaemonExecutionStatusResponse
  | {
      readonly kind: "result-acknowledged";
      readonly instanceId: string;
      readonly processToken: string;
      readonly requestId: string;
      readonly transferId: string;
    };

export type DaemonServerMessage = DaemonResponse | DaemonResultChunk;

export type DaemonPong = Extract<DaemonResponse, { readonly kind: "pong" }>;

export interface DaemonServer {
  close(force?: boolean): Promise<void>;
}

export type DaemonStartResult =
  | {
      readonly status: "ready";
      readonly workspaceRoot: string;
      readonly fileCount: number;
      readonly loadDurationMs: number;
    }
  | {
      readonly status: "already-running";
      readonly workspaceRoot: string;
      readonly pid: number;
      readonly uptimeMs: number;
    }
  | { readonly status: "disabled" };
