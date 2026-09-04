import { describe, expectTypeOf, it } from "vitest";

import {
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

describe("daemon admission contracts", () => {
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
});
