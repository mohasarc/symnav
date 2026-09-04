import { describe, expect, expectTypeOf, it } from "vitest";

import * as daemonRuntime from "@symnav/daemon";
import type {
  DaemonActivitySnapshot,
  DaemonAdmissionContext,
  DaemonExecuteRejectionCode,
  DaemonExecutionFailureCode,
  DaemonExecutionFailureContext,
  DaemonExecutor,
  DaemonPolicyValues,
  DaemonReadinessProbe,
  DaemonStartResult,
  DaemonStatusEnvelope,
  DaemonStopResult,
  DaemonWorkerFailureCode,
} from "@symnav/daemon";
import {
  DAEMON_COMMAND_NAMES,
  DaemonExecutionFailures,
  DaemonPolicy,
} from "@symnav/daemon";

describe("@symnav/daemon public package import", () => {
  it("resolves the root contract", () => {
    expectTypeOf<DaemonExecutor>().toBeObject();
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
    expect(DaemonExecutionFailures.isCode("internal")).toBe(true);
    expect(DAEMON_COMMAND_NAMES).toHaveLength(10);
    expect(DaemonPolicy.fromSystemMemory({ totalBytes: 1024 * 1024 * 1024 })).toBeInstanceOf(
      DaemonPolicy,
    );
    expect(Object.keys(daemonRuntime)).toEqual([
      "DAEMON_COMMAND_NAMES",
      "DaemonExecutionFailures",
      "DaemonPolicy",
    ]);
  });
});
