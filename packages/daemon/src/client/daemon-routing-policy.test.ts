import { describe, expect, it, vi } from "vitest";
import {
  DaemonRoutingContextState,
  DaemonRoutingPolicy,
  type DaemonRouteSnapshot,
  type DaemonRoutingContext,
} from "./daemon-routing-policy.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonPong,
  type DaemonRecord,
} from "../transport/protocol.js";
import type { DaemonObservation } from "../registry/record-observer.js";
import type { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";

describe("DaemonRoutingPolicy", () => {
  it.each([
    ["absent", { record: undefined }, { kind: "cold", reason: "absent" }, 1, 0, 0],
    [
      "registry recovery",
      { readFailure: new Error("registry unavailable") },
      { kind: "cold", reason: "recovering" },
      1,
      0,
      0,
    ],
    [
      "starting record",
      { record: record({ state: "starting", readyAt: undefined, fileCount: undefined }) },
      { kind: "cold", reason: "starting" },
      1,
      0,
      0,
    ],
    [
      "record version mismatch",
      { record: record({ symnavVersion: "0.0.9" }) },
      { kind: "fallback", reason: "incompatible" },
      1,
      0,
      0,
    ],
    ["ready idle", { pongState: "ready" }, { kind: "warm", record: record() }, 1, 1, 0],
    ["ready busy", { pongState: "busy" }, { kind: "warm", record: record() }, 1, 1, 0],
    [
      "responsive starting",
      { pongState: "starting" },
      { kind: "cold", reason: "recovering" },
      1,
      1,
      0,
    ],
    [
      "pong version mismatch",
      { pongVersion: "0.0.9" },
      { kind: "fallback", reason: "incompatible" },
      1,
      1,
      0,
    ],
    [
      "observation recovery",
      { observationFailure: new Error("probe unavailable") },
      { kind: "cold", reason: "recovering" },
      1,
      1,
      0,
    ],
    [
      "starting observation",
      { observationKind: "starting" },
      { kind: "cold", reason: "starting" },
      1,
      1,
      0,
    ],
    [
      "unresponsive observation",
      { observationKind: "unresponsive" },
      { kind: "cold", reason: "recovering" },
      1,
      1,
      0,
    ],
    [
      "exited observation",
      { observationKind: "exited" },
      { kind: "fallback", reason: "dead" },
      1,
      1,
      1,
    ],
    [
      "incompatible observation",
      { observationKind: "incompatible" },
      { kind: "fallback", reason: "incompatible" },
      1,
      1,
      0,
    ],
    [
      "corrupt observation",
      { observationKind: "corrupt" },
      { kind: "fallback", reason: "incompatible" },
      1,
      1,
      0,
    ],
  ] as const)(
    "routes %s with lazy first-decision effects",
    async (_name, options, expected, reads, observations, removals) => {
      const harness = new RoutingHarness(options);

      await expect(new DaemonRoutingPolicy().decide(harness.context)).resolves.toEqual(expected);

      expect(harness.readRecord).toHaveBeenCalledTimes(reads);
      expect(harness.observe).toHaveBeenCalledTimes(observations);
      expect(harness.removeIfProcess).toHaveBeenCalledTimes(removals);
    },
  );

  it("performs no work until a decision and memoizes context operations", async () => {
    const harness = new RoutingHarness({});

    expect(harness.readRecord).not.toHaveBeenCalled();
    expect(harness.observe).not.toHaveBeenCalled();
    await harness.context.readRecord();
    await harness.context.readRecord();
    await harness.context.observe(record());
    await harness.context.observe(record());

    expect(harness.readRecord).toHaveBeenCalledOnce();
    expect(harness.observe).toHaveBeenCalledOnce();
  });
});

interface RoutingHarnessOptions {
  readonly record?: DaemonRecord;
  readonly readFailure?: Error;
  readonly observationFailure?: Error;
  readonly observationKind?: DaemonObservation["kind"];
  readonly pongState?: DaemonPong["state"];
  readonly pongVersion?: string;
}

class RoutingHarness {
  readonly readRecord = vi.fn();
  readonly observe = vi.fn();
  readonly removeIfProcess = vi.fn(() => true);
  readonly context: DaemonRoutingContext;

  constructor(options: RoutingHarnessOptions) {
    this.readRecord.mockImplementation(() => {
      if (options.readFailure !== undefined) throw options.readFailure;
      return Object.hasOwn(options, "record") ? options.record : record();
    });
    this.observe.mockImplementation(async (observed: DaemonRecord): Promise<DaemonObservation> => {
      if (options.observationFailure !== undefined) throw options.observationFailure;
      const kind = options.observationKind ?? "responsive";
      if (kind === "responsive") {
        return {
          kind,
          record: observed,
          pong: {
            kind: "pong",
            protocolVersion: observed.protocolVersion,
            instanceId: observed.instanceId,
            symnavVersion: options.pongVersion ?? observed.symnavVersion,
            state: options.pongState ?? "ready",
          },
        };
      }
      if (kind === "starting" || kind === "exited") return { kind, record: observed };
      if (kind === "unresponsive") {
        return { kind, record: observed, failureCode: "timeout" };
      }
      return {
        kind,
        record: observed,
        evidence: {
          instanceId: observed.instanceId,
          processToken: observed.processToken,
          pid: observed.pid,
          startedAt: observed.startedAt,
        },
      };
    });
    this.context = new DaemonRoutingContextState(
      {} as DaemonWorkspaceIdentity,
      "0.1.0",
      this.readRecord,
      this.observe,
      this.removeIfProcess,
    );
  }
}

function record(overrides: Partial<DaemonRecord> = {}): DaemonRecord {
  return {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    workspaceRoot: "/workspace",
    workspaceKey: "workspace-key",
    stateKey: "state-key",
    identityKey: "identity-key",
    instanceId: "instance-1",
    processToken: "process-1",
    endpoint: "/endpoint",
    pid: 123,
    state: "ready",
    startedAt: 1,
    readyAt: 2,
    fileCount: 1,
    memoryCapBytes: 1024,
    ...overrides,
  };
}
