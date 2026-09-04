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

class AuthenticationAdmissionGuard implements DaemonAdmissionGuard {
  rejectionFor(context: DaemonAdmissionContext): DaemonAdmissionRejectionCode | undefined {
    return context.authenticated ? undefined : "authentication";
  }
}

class WorkerReadinessAdmissionGuard implements DaemonAdmissionGuard {
  rejectionFor(context: DaemonAdmissionContext): DaemonAdmissionRejectionCode | undefined {
    return context.workerReady ? undefined : "not-ready";
  }
}

class ResourceAdmissionGuard implements DaemonAdmissionGuard {
  rejectionFor(context: DaemonAdmissionContext): DaemonAdmissionRejectionCode | undefined {
    return context.resourceAdmissionPaused ? "resource-pressure" : undefined;
  }
}

class QueueAdmissionGuard implements DaemonAdmissionGuard {
  rejectionFor(context: DaemonAdmissionContext): DaemonAdmissionRejectionCode | undefined {
    return context.queueState === "accepting" ? undefined : "draining";
  }
}

class CompatibilityAdmissionGuard implements DaemonAdmissionGuard {
  rejectionFor(context: DaemonAdmissionContext): DaemonAdmissionRejectionCode | undefined {
    return context.compatibility === "conflicting" ? "incompatible" : undefined;
  }
}

export class DaemonAdmissionPolicy {
  private readonly guards: readonly DaemonAdmissionGuard[] = [
    new AuthenticationAdmissionGuard(),
    new WorkerReadinessAdmissionGuard(),
    new ResourceAdmissionGuard(),
    new QueueAdmissionGuard(),
    new CompatibilityAdmissionGuard(),
  ];

  decide(context: DaemonAdmissionContext): DaemonAdmissionDecision {
    for (const guard of this.guards) {
      const rejection = guard.rejectionFor(context);
      if (rejection === undefined) continue;
      if (rejection === "authentication") return { kind: "disconnect", code: rejection };
      return { kind: "reject", code: rejection };
    }
    return { kind: "accept" };
  }
}

export class DaemonAdmissionRejections {
  private static readonly retrySafety: Readonly<Record<DaemonExecuteRejectionCode, boolean>> =
    Object.freeze({
      "not-ready": true,
      draining: true,
      "resource-pressure": true,
      incompatible: false,
    });

  static retrySafe(code: DaemonExecuteRejectionCode): boolean {
    return DaemonAdmissionRejections.retrySafety[code];
  }

  static frame(
    code: DaemonExecuteRejectionCode,
    coordinates: DaemonExecutionCoordinates,
  ): DaemonRejectedExecutionFrame {
    return {
      kind: "rejected",
      ...coordinates,
      code,
      retrySafe: DaemonAdmissionRejections.retrySafe(code),
    };
  }

  static assertConsistent(frame: DaemonRejectedExecutionFrame): void {
    if (
      !Object.hasOwn(DaemonAdmissionRejections.retrySafety, frame.code) ||
      frame.retrySafe !== DaemonAdmissionRejections.retrySafety[frame.code]
    ) {
      throw new Error("Inconsistent daemon execution rejection");
    }
  }
}
