import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DaemonAdmissionPolicy,
  type AcceptedRequestCompatibility,
  type DaemonAdmissionContext,
  type DaemonAdmissionDecision,
  type DaemonAdmissionGuard,
  type DaemonAdmissionRejectionCode,
  type DaemonExecuteRejectionCode,
  type DaemonExecutionCoordinates,
  type DaemonRejectedExecutionFrame,
  type WorkspaceRequestQueueState,
} from "./daemon-admission.js";

describe("DaemonAdmissionPolicy", () => {
  it("defines the closed admission contracts", () => {
    expectTypeOf<AcceptedRequestCompatibility>().toEqualTypeOf<
      "unseen" | "matching" | "conflicting"
    >();
    expectTypeOf<WorkspaceRequestQueueState>().toEqualTypeOf<"accepting" | "draining" | "closed">();
    expectTypeOf<DaemonAdmissionRejectionCode>().toEqualTypeOf<
      "authentication" | "not-ready" | "draining" | "resource-pressure" | "incompatible"
    >();
    expectTypeOf<DaemonAdmissionDecision>().toEqualTypeOf<
      | { readonly kind: "accept" }
      | { readonly kind: "disconnect"; readonly code: "authentication" }
      | { readonly kind: "reject"; readonly code: DaemonExecuteRejectionCode }
    >();
    expectTypeOf<DaemonAdmissionGuard>().toEqualTypeOf<{
      rejectionFor(context: DaemonAdmissionContext): DaemonAdmissionRejectionCode | undefined;
    }>();
  });

  it.each([
    ["authentication before readiness", ["authentication", "worker"]],
    ["authentication before resources", ["authentication", "resource"]],
    ["authentication before draining", ["authentication", "queue"]],
    ["authentication before conflicts", ["authentication", "compatibility"]],
    ["readiness before resources", ["worker", "resource"]],
    ["readiness before draining", ["worker", "queue"]],
    ["readiness before conflicts", ["worker", "compatibility"]],
    ["resources before draining", ["resource", "queue"]],
    ["resources before conflicts", ["resource", "compatibility"]],
    ["draining before conflicts", ["queue", "compatibility"]],
  ] as const)("selects %s", (_name, failures) => {
    const context = AdmissionContexts.create();
    for (const failure of failures) AdmissionContexts.applyFailure(context, failure);

    expect(new DaemonAdmissionPolicy().decide(context)).toEqual(
      AdmissionContexts.decisionFor(failures[0]),
    );
  });

  it.each(["draining", "closed"] as const)("rejects a %s queue as draining", (queueState) => {
    expect(new DaemonAdmissionPolicy().decide(AdmissionContexts.create({ queueState }))).toEqual({
      kind: "reject",
      code: "draining",
    });
  });

  it.each(["unseen", "matching"] as const)("accepts %s compatible work", (compatibility) => {
    expect(new DaemonAdmissionPolicy().decide(AdmissionContexts.create({ compatibility }))).toEqual(
      { kind: "accept" },
    );
  });
});

type AdmissionFailure = "authentication" | "worker" | "resource" | "queue" | "compatibility";

interface MutableAdmissionContext {
  request: unknown;
  authenticated: boolean;
  workerReady: boolean;
  resourceAdmissionPaused: boolean;
  queueState: WorkspaceRequestQueueState;
  compatibility: AcceptedRequestCompatibility;
}

class AdmissionContexts {
  static create(overrides: Partial<DaemonAdmissionContext> = {}): MutableAdmissionContext {
    return {
      request: {},
      authenticated: true,
      workerReady: true,
      resourceAdmissionPaused: false,
      queueState: "accepting",
      compatibility: "unseen",
      ...overrides,
    };
  }

  static applyFailure(context: MutableAdmissionContext, failure: AdmissionFailure): void {
    if (failure === "authentication") context.authenticated = false;
    if (failure === "worker") context.workerReady = false;
    if (failure === "resource") context.resourceAdmissionPaused = true;
    if (failure === "queue") context.queueState = "draining";
    if (failure === "compatibility") context.compatibility = "conflicting";
  }

  static decisionFor(failure: AdmissionFailure): DaemonAdmissionDecision {
    if (failure === "authentication") return { kind: "disconnect", code: "authentication" };
    if (failure === "worker") return { kind: "reject", code: "not-ready" };
    if (failure === "resource") return { kind: "reject", code: "resource-pressure" };
    if (failure === "queue") return { kind: "reject", code: "draining" };
    return { kind: "reject", code: "incompatible" };
  }
}
