import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DaemonExecutionFailureCode,
  DaemonExecutor,
  DaemonExecutorExecutionResult,
  DaemonExecutorRequest,
} from "@symnav/daemon";
import { DaemonPolicy } from "../daemon-policy.js";
import { CommandOutputSnapshot } from "../../test/helpers/executor-output.js";
import { DaemonStartupCoordinator } from "../registry/startup-coordinator.js";
import { DaemonRecordObserver } from "../registry/record-observer.js";
import { DaemonRegistry } from "../registry/registry.js";
import { LocalDaemonTransport } from "../transport/local-transport.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "../transport/protocol.js";
import { DaemonTransportError } from "../transport/transport-error.js";
import { DaemonClient } from "./daemon-client.js";

const success: DaemonExecutorExecutionResult = {
  exitCode: 0,
  output: new CommandOutputSnapshot([{ stream: "stdout", bytes: Buffer.from("answer\n") }]),
};

describe("DaemonClient execution", () => {
  afterEach(() => vi.restoreAllMocks());

  it("executes a disabled request cold without touching registry or startup", async () => {
    const harness = new ClientHarness({ daemonEnabled: false });

    await expect(harness.client.execute(harness.request())).resolves.toEqual({
      mode: "cold",
      result: success,
    });

    expect(harness.registryRead).not.toHaveBeenCalled();
    expect(harness.trigger).not.toHaveBeenCalled();
    expect(harness.executorFactory).toHaveBeenCalledOnce();
    expect(harness.localRequests).toEqual([
      expect.objectContaining({ executionMode: "cold", telemetryEnabled: true }),
    ]);
  });

  it.each([
    ["absent", { record: undefined }, "cold", "cold", 1],
    ["starting", { record: daemonRecord({ state: "starting" }) }, "cold", "cold", 0],
    [
      "incompatible",
      { record: daemonRecord({ symnavVersion: "0.0.9" }) },
      "fallback",
      "fallback",
      1,
    ],
  ] as const)(
    "executes %s locally with one fresh executor and expected trigger",
    async (_name, options, mode, executionMode, triggers) => {
      const harness = new ClientHarness(options);

      await expect(harness.client.execute(harness.request())).resolves.toEqual({
        mode,
        result: success,
      });

      expect(harness.executorFactory).toHaveBeenCalledOnce();
      expect(harness.localRequests).toEqual([
        expect.objectContaining({ executionMode, telemetryEnabled: true }),
      ]);
      expect(harness.trigger).toHaveBeenCalledTimes(triggers);
    },
  );

  it("does not await independent warmup or switch a chosen cold route", async () => {
    const harness = new ClientHarness({ record: undefined, neverResolveTrigger: true });

    await expect(harness.client.execute(harness.request())).resolves.toEqual({
      mode: "cold",
      result: success,
    });

    expect(harness.executorFactory).toHaveBeenCalledOnce();
    expect(harness.warmRequests).toHaveLength(0);
  });

  it("creates a new executor for every local attempt", async () => {
    const harness = new ClientHarness({ record: undefined });

    await harness.client.execute(harness.request());
    await harness.client.execute(harness.request());

    expect(harness.executorFactory).toHaveBeenCalledTimes(2);
    expect(harness.executors).toHaveLength(2);
    expect(harness.executors[0]).not.toBe(harness.executors[1]);
  });

  it("executes ready requests warm without creating a host executor", async () => {
    const harness = new ClientHarness({});

    await expect(harness.client.execute(harness.request())).resolves.toEqual({
      mode: "warm",
      result: success,
    });

    expect(harness.executorFactory).not.toHaveBeenCalled();
    expect(harness.warmRequests).toEqual([
      expect.objectContaining({
        commandName: "overview",
        request: {
          argv: ["overview", "src/a.ts"],
          cwd: "/workspace",
          telemetryEnabled: true,
          executionMode: "warm",
        },
      }),
    ]);
  });

  it.each([
    new DaemonTransportError("unreachable", "not-submitted", "connection refused"),
    new DaemonTransportError(
      "rejected",
      "submitted-unconfirmed",
      "not ready",
      "instance-1",
      "not-ready",
    ),
  ])("falls back once after retry-safe warm failure %#", async (failure) => {
    const harness = new ClientHarness({ warmFailure: failure });

    await expect(harness.client.execute(harness.request())).resolves.toEqual({
      mode: "fallback",
      result: success,
    });

    expect(harness.executorFactory).toHaveBeenCalledOnce();
    expect(harness.localRequests).toHaveLength(1);
  });

  it.each([
    new DaemonTransportError("timeout", "submitted-unconfirmed", "request timed out"),
    new DaemonTransportError("closed", "accepted", "request closed", "instance-1"),
    new DaemonTransportError(
      "rejected",
      "submitted-unconfirmed",
      "incompatible",
      "instance-1",
      "incompatible",
    ),
    new Error("malformed response"),
  ])("does not replay uncertain warm failure %#", async (failure) => {
    const harness = new ClientHarness({ warmFailure: failure });

    const result = await harness.client.execute(harness.request());

    expect(result.mode).toBe("warm");
    expect(result.result.exitCode).toBe(1);
    await expect(outputText(result.result)).resolves.toBe(
      "Cannot answer: accepted daemon request did not complete.\n",
    );
    expect(harness.executorFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["controlled-resource", "Cannot answer: daemon workspace capacity exceeded.\n"],
    ["response-capacity", "Cannot answer: daemon response capacity exceeded.\n"],
    ["worker-exit", "Cannot answer: accepted daemon request did not complete.\n"],
    ["stopping", "Cannot answer: accepted daemon request did not complete.\n"],
    ["internal", "Cannot answer: accepted daemon request did not complete.\n"],
  ] as const)("owns the exact controlled result for %s", async (code, message) => {
    const harness = new ClientHarness({ terminalFailure: code });

    const result = await harness.client.execute(harness.request());

    expect(result.mode).toBe("warm");
    expect(result.result.exitCode).toBe(1);
    await expect(outputText(result.result)).resolves.toBe(message);
    expect(harness.executorFactory).not.toHaveBeenCalled();
  });

  it("disposes malformed warm output before returning its controlled result", async () => {
    const output = new CommandOutputSnapshot([]);
    const dispose = vi.spyOn(output, "dispose");
    const harness = new ClientHarness({ warmResult: { exitCode: 1.5, output } });

    const result = await harness.client.execute(harness.request());

    expect(result.mode).toBe("warm");
    expect(result.result.exitCode).toBe(1);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

interface ClientHarnessOptions {
  readonly daemonEnabled?: boolean;
  readonly record?: DaemonRecord | undefined;
  readonly neverResolveTrigger?: boolean;
  readonly warmFailure?: Error;
  readonly warmResult?: DaemonExecutorExecutionResult;
  readonly terminalFailure?: DaemonExecutionFailureCode;
}

class ClientHarness {
  readonly executorFactory = vi.fn();
  readonly executors: DaemonExecutor[] = [];
  readonly localRequests: DaemonExecutorRequest[] = [];
  readonly warmRequests: unknown[] = [];
  readonly registryRead: unknown;
  readonly trigger: unknown;
  readonly client: DaemonClient;

  constructor(options: ClientHarnessOptions) {
    this.registryRead = vi
      .spyOn(DaemonRegistry.prototype, "read")
      .mockReturnValue(Object.hasOwn(options, "record") ? options.record : daemonRecord());
    vi.spyOn(DaemonRecordObserver.prototype, "observe").mockImplementation(async (observed) => ({
      kind: "responsive",
      record: observed,
      pong: {
        kind: "pong",
        protocolVersion: observed.protocolVersion,
        instanceId: observed.instanceId,
        symnavVersion: observed.symnavVersion,
        state: "ready",
      },
    }));
    this.trigger = vi
      .spyOn(DaemonStartupCoordinator.prototype, "trigger")
      .mockImplementation(() =>
        options.neverResolveTrigger
          ? new Promise(() => {})
          : Promise.resolve({ status: "launched", instanceId: "replacement", pid: 321 }),
      );
    vi.spyOn(LocalDaemonTransport.prototype, "execute").mockImplementation(
      async (_endpoint, request) => {
        this.warmRequests.push(request);
        if (options.warmFailure !== undefined) throw options.warmFailure;
        return {
          acceptance: {
            requestId: request.requestId,
            instanceId: request.instanceId,
            acceptedAt: 1,
            queuePosition: 0,
          },
          completion:
            options.terminalFailure === undefined
              ? Promise.resolve({ status: "completed", result: options.warmResult ?? success })
              : Promise.resolve({ status: "failed", code: options.terminalFailure }),
        };
      },
    );
    this.executorFactory.mockImplementation(() => {
      const executor: DaemonExecutor = {
        initialize: async () => ({ fileCount: 0 }),
        execute: async (request) => {
          this.localRequests.push(request);
          return success;
        },
        releaseTransientResources: async () => undefined,
      };
      this.executors.push(executor);
      return executor;
    });
    this.client = new DaemonClient({
      stateDirectory: "/state",
      productVersion: "0.1.0",
      daemonEnabled: options.daemonEnabled ?? true,
      executorFactory: this.executorFactory,
      executorModuleUrl: "file:///executor.js",
      readinessProbe: { commandName: "version", argv: ["--version"] },
      policy: DaemonPolicy.currentSystem(),
    });
  }

  request() {
    return {
      workspaceRoot: "/workspace",
      commandName: "overview" as const,
      argv: ["overview", "src/a.ts"],
      cwd: "/workspace",
      telemetryEnabled: true,
    };
  }
}

function daemonRecord(overrides: Partial<DaemonRecord> = {}): DaemonRecord {
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

async function outputText(result: DaemonExecutorExecutionResult): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const outputRecord of result.output.records()) chunks.push(outputRecord.bytes);
  await result.output.dispose();
  return Buffer.concat(chunks).toString();
}
