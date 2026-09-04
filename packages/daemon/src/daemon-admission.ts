export type DaemonExecuteRejectionCode =
  | "not-ready"
  | "draining"
  | "resource-pressure"
  | "incompatible";

export type AcceptedRequestCompatibility = "unseen" | "matching" | "conflicting";

export type WorkspaceRequestQueueState = "accepting" | "draining" | "closed";

export type DaemonExecutionCoordinates = {
  readonly instanceId: string;
  readonly processToken: string;
  readonly requestId: string;
};

export type DaemonRejectedExecutionFrame = {
  readonly kind: "rejected";
  readonly instanceId: string;
  readonly processToken: string;
  readonly requestId: string;
  readonly code: DaemonExecuteRejectionCode;
  readonly retrySafe: boolean;
};

export interface DaemonAdmissionContext {
  readonly request: unknown;
  readonly authenticated: boolean;
  readonly workerReady: boolean;
  readonly resourceAdmissionPaused: boolean;
  readonly queueState: WorkspaceRequestQueueState;
  readonly compatibility: AcceptedRequestCompatibility;
}

export interface DaemonAdmissionGuard {
  rejectionFor(context: DaemonAdmissionContext): DaemonAdmissionRejectionCode | undefined;
}

export type DaemonAdmissionRejectionCode = "authentication" | DaemonExecuteRejectionCode;

export type DaemonAdmissionDecision =
  | { readonly kind: "accept" }
  | { readonly kind: "disconnect"; readonly code: "authentication" }
  | { readonly kind: "reject"; readonly code: DaemonExecuteRejectionCode };
