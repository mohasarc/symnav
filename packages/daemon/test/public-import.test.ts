import { describe, expect, expectTypeOf, it } from "vitest";

import * as daemonRuntime from "@symnav/daemon";
import type {
  DaemonActivitySnapshot,
  DaemonAdmissionContext,
  DaemonExecuteRejectionCode,
  DaemonExecutionFailureCode,
  DaemonExecutionFailureContext,
  DaemonExecutor,
  DaemonOutputSink,
  DaemonPolicyValues,
  DaemonReadinessProbe,
  DaemonStartResult,
  DaemonStatusEnvelope,
  DaemonStopResult,
  DaemonWorkerFailureCode,
} from "@symnav/daemon";
import {
  DAEMON_COMMAND_NAMES,
  DaemonAdmissionPolicy,
  DaemonAdmissionRejections,
  DaemonDiagnosticValues,
  DaemonExecutionFailures,
  DaemonPolicy,
} from "@symnav/daemon";

describe("@symnav/daemon public package import", () => {
  it("resolves the root contract", () => {
    expectTypeOf<DaemonExecutor>().toBeObject();
    expectTypeOf<DaemonOutputSink>().toBeObject();
    expectTypeOf<DaemonActivitySnapshot>().toBeObject();
    expectTypeOf<DaemonStatusEnvelope>().toBeObject();
    expectTypeOf<DaemonStartResult>().not.toBeNever();
    expectTypeOf<DaemonStopResult>().not.toBeNever();
    expectTypeOf<DaemonPolicyValues>().toBeObject();
    expectTypeOf<DaemonReadinessProbe>().toBeObject();
    expectTypeOf<DaemonExecutionFailureCode>().not.toBeNever();
    expectTypeOf<DaemonExecutionFailureContext>().toBeObject();
    expectTypeOf<DaemonWorkerFailureCode>().not.toBeNever();
    expectTypeOf<DaemonAdmissionContext>().toBeObject();
    expectTypeOf<DaemonExecuteRejectionCode>().not.toBeNever();
    expect(
      new DaemonAdmissionPolicy().decide({
        request: {},
        authenticated: true,
        workerReady: true,
        resourceAdmissionPaused: false,
        queueState: "accepting",
        compatibility: "unseen",
      }),
    ).toEqual({ kind: "accept" });
    expect(DaemonAdmissionRejections.retrySafe("not-ready")).toBe(true);
    expect(DaemonDiagnosticValues.isDiagnostics({ nested: ["opaque"] })).toBe(true);
    expect(DaemonExecutionFailures.isCode("internal")).toBe(true);
    expect(DAEMON_COMMAND_NAMES).toHaveLength(10);
    expect(DaemonPolicy.fromSystemMemory({ totalBytes: 1024 * 1024 * 1024 })).toBeInstanceOf(
      DaemonPolicy,
    );
    expect(Object.keys(daemonRuntime)).toEqual([
      "DaemonAdmissionPolicy",
      "DaemonAdmissionRejections",
      "DAEMON_COMMAND_NAMES",
      "DaemonDiagnosticValues",
      "DaemonExecutionFailures",
      "DaemonPolicy",
    ]);
  });
});
