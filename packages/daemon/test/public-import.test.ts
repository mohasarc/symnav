import { describe, expect, expectTypeOf, it } from "vitest";

import * as daemonRuntime from "@symnav/daemon";
import type {
  DaemonActivitySnapshot,
  DaemonExecutor,
  DaemonPolicyValues,
  DaemonReadinessProbe,
  DaemonStartResult,
  DaemonStatusEnvelope,
  DaemonStopResult,
} from "@symnav/daemon";
import { DAEMON_COMMAND_NAMES, DaemonPolicy } from "@symnav/daemon";

describe("@symnav/daemon public package import", () => {
  it("resolves the root contract with only the policy runtime", () => {
    expectTypeOf<DaemonExecutor>().toBeObject();
    expectTypeOf<DaemonActivitySnapshot>().toBeObject();
    expectTypeOf<DaemonStatusEnvelope>().toBeObject();
    expectTypeOf<DaemonStartResult>().not.toBeNever();
    expectTypeOf<DaemonStopResult>().not.toBeNever();
    expectTypeOf<DaemonPolicyValues>().toBeObject();
    expectTypeOf<DaemonReadinessProbe>().toBeObject();
    expect(DAEMON_COMMAND_NAMES).toHaveLength(10);
    expect(DaemonPolicy.fromSystemMemory({ totalBytes: 1024 * 1024 * 1024 })).toBeInstanceOf(
      DaemonPolicy,
    );
    expect(Object.keys(daemonRuntime)).toEqual(["DAEMON_COMMAND_NAMES", "DaemonPolicy"]);
  });
});
