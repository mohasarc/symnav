import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UsageEventInput } from "@symnav/telemetry";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-protocol.js";
import {
  DaemonCommandDispatcher,
  type DaemonDispatchRuntime,
} from "./daemon-command-dispatcher.js";

const workspaceRoot = resolve("synthetic-workspace");
const nestedWorkspaceDirectory = join(workspaceRoot, "nested");
const request: CliExecutionRequest = {
  argv: ["overview", "src/a.ts"],
  cwd: workspaceRoot,
  telemetryEnabled: false,
};
const success: CommandExecutionResult = {
  frames: [{ stream: "stdout", bytesBase64: Buffer.from("answer\n").toString("base64") }],
  exitCode: 0,
};
const userError: CommandExecutionResult = {
  frames: [{ stream: "stderr", bytesBase64: Buffer.from("bad\n").toString("base64") }],
  exitCode: 1,
};

describe("DaemonCommandDispatcher", () => {
  it("returns one complete result from an existing daemon", async () => {
    const harness = new DispatchHarness(success);

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "warm",
      result: success,
    });
    expect(harness.ensureRunning).not.toHaveBeenCalled();
    expect(harness.coldExecute).not.toHaveBeenCalled();
    expect(harness.executeRequests()).toEqual([
      expect.objectContaining({
        kind: "execute",
        request: expect.objectContaining({ executionMode: "warm" }),
      }),
    ]);
  });

  it.each([
    { frames: [], exitCode: 1.5 },
    { frames: "invalid", exitCode: 0 },
    { frames: [{ stream: "invalid", bytesBase64: "" }], exitCode: 0 },
    { frames: [{ stream: "stdout", bytesBase64: "***" }], exitCode: 0 },
  ])("falls back from incomplete daemon result %#", async (incomplete) => {
    const harness = new DispatchHarness(incomplete as unknown as CommandExecutionResult);

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "fallback",
      result: success,
    });
    expect(harness.coldExecute).toHaveBeenCalledOnce();
  });

  it("sends an absolute cwd override to the daemon", async () => {
    const harness = new DispatchHarness(success);

    await harness.dispatcher().execute({
      ...request,
      argv: ["--cwd", "..", ...request.argv],
      cwd: nestedWorkspaceDirectory,
    });

    expect(harness.executeRequests()).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ argv: ["--cwd", workspaceRoot, ...request.argv] }),
      }),
    ]);
  });

  it("elects a starter when no daemon is registered", async () => {
    const harness = new DispatchHarness(success, { initiallyRegistered: false });

    const dispatched = await harness.dispatcher().execute(request);

    expect(dispatched.mode).toBe("warm");
    expect(harness.ensureRunning).toHaveBeenCalledOnce();
  });

  it.each([
    ["concurrent initial startup", { state: "starting" as const }],
    ["version replacement", { symnavVersion: "0.0.9" }],
  ])("waits for %s before warm execution", async (_name, record) => {
    const harness = new DispatchHarness(success, { record });

    await expect(harness.dispatcher().execute(request)).resolves.toMatchObject({ mode: "warm" });

    expect(harness.ensureRunning).toHaveBeenCalledOnce();
    expect(harness.coldExecute).not.toHaveBeenCalled();
  });

  it.each([
    "connection refused",
    "malformed result",
    "truncated result",
    "mismatched result",
    "mid-request disconnect",
  ])("executes one cold fallback after %s", async (message) => {
    const harness = new DispatchHarness(new Error(message));

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "fallback",
      result: success,
    });
    expect(harness.coldExecute).toHaveBeenCalledTimes(1);
    expect(harness.coldExecute).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "fallback" }),
    );
  });

  it("invalidates a failed daemon and restarts on the next invocation", async () => {
    const harness = new DispatchHarness(success);
    const dispatcher = harness.dispatcher();
    await expect(dispatcher.execute(request)).resolves.toMatchObject({ mode: "warm" });
    harness.answer(new Error("connection refused"));

    await expect(dispatcher.execute(request)).resolves.toEqual({
      mode: "fallback",
      result: success,
    });
    expect(harness.ensureRunning).not.toHaveBeenCalled();
    expect(harness.registeredRecord()).toBeUndefined();
    expect(harness.coldExecute).toHaveBeenCalledTimes(1);

    harness.answer(success);
    await expect(dispatcher.execute(request)).resolves.toMatchObject({ mode: "warm" });
    expect(harness.ensureRunning).toHaveBeenCalledOnce();
  });

  it("removes a failed daemon record when kill delivery fails", async () => {
    const harness = new DispatchHarness(new Error("connection refused"));
    harness.failKill(new Error("kill refused"));

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "fallback",
      result: success,
    });

    expect(harness.removeIfInstance).toHaveBeenCalledOnce();
    expect(harness.registeredRecord()).toBeUndefined();
    expect(harness.coldExecute).toHaveBeenCalledOnce();
  });

  it("executes fallback when failed daemon record cleanup fails", async () => {
    const harness = new DispatchHarness(new Error("connection refused"));
    harness.failRemoval(new Error("registry cleanup failed"));

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "fallback",
      result: success,
    });

    expect(harness.removeIfInstance).toHaveBeenCalledOnce();
    expect(harness.coldExecute).toHaveBeenCalledOnce();
  });

  it("executes one fallback when initial registry discovery throws", async () => {
    const harness = new DispatchHarness(success, { registryReadFailures: [1] });

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "fallback",
      result: success,
    });

    expect(harness.ensureRunning).not.toHaveBeenCalled();
    expect(harness.removeIfInstance).not.toHaveBeenCalled();
    expect(harness.coldExecute).toHaveBeenCalledTimes(1);
  });

  it("executes one fallback when recovery registry discovery throws", async () => {
    const harness = new DispatchHarness(success, {
      initiallyRegistered: false,
      ensureFailure: new Error("startup failed"),
      registryReadFailures: [2],
    });

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "fallback",
      result: success,
    });

    expect(harness.ensureRunning).toHaveBeenCalledOnce();
    expect(harness.removeIfInstance).not.toHaveBeenCalled();
    expect(harness.coldExecute).toHaveBeenCalledTimes(1);
  });
  it("does not touch daemon state when disabled", async () => {
    const harness = new DispatchHarness(success, { daemonEnabled: false });

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "cold",
      result: success,
    });
    expect(harness.runtimeFactory).not.toHaveBeenCalled();
    expect(harness.coldExecute).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "cold" }),
    );
  });

  it("replays normal nonzero daemon results without retrying", async () => {
    const harness = new DispatchHarness(userError);

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "warm",
      result: userError,
    });
    expect(harness.coldExecute).not.toHaveBeenCalled();
  });

  it("commits deferred warm telemetry only after receiving the complete result", async () => {
    const warmTelemetry = telemetryInput("warm");
    const harness = new DispatchHarness({ ...success, telemetry: warmTelemetry });

    await expect(
      harness.dispatcher().execute({ ...request, telemetryEnabled: true }),
    ).resolves.toEqual({
      mode: "warm",
      result: success,
    });

    expect(harness.recordTelemetry).toHaveBeenCalledWith(warmTelemetry);
    expect(harness.recordTelemetry).toHaveBeenCalledTimes(1);
  });

  it("falls back without recording malformed deferred telemetry", async () => {
    const harness = new DispatchHarness({
      ...success,
      telemetry: { executionMode: "warm" } as UsageEventInput,
    });

    await expect(
      harness.dispatcher().execute({ ...request, telemetryEnabled: true }),
    ).resolves.toEqual({ mode: "fallback", result: success });
    expect(harness.recordTelemetry).not.toHaveBeenCalled();
    expect(harness.coldExecute).toHaveBeenCalledOnce();
  });
});

interface DispatchHarnessOptions {
  readonly daemonEnabled?: boolean;
  readonly initiallyRegistered?: boolean;
  readonly record?: Partial<DaemonRecord>;
  readonly ensureFailure?: Error;
  readonly registryReadFailures?: readonly number[];
}

class DispatchHarness {
  readonly ensureRunning: ReturnType<typeof vi.fn>;
  readonly removeIfInstance = vi.fn();
  readonly coldExecute = vi.fn(async () => success);
  readonly recordTelemetry = vi.fn();
  readonly runtimeFactory = vi.fn(() => this.runtime);
  private readonly requests: DaemonRequest[] = [];
  private registered: DaemonRecord | undefined;
  private readonly runtime: DaemonDispatchRuntime;
  private daemonAnswer: CommandExecutionResult | Error;
  private killFailure: Error | undefined;
  private removalFailure: Error | undefined;
  private registryReadCount = 0;

  constructor(
    daemonAnswer: CommandExecutionResult | Error,
    private readonly options: DispatchHarnessOptions = {},
  ) {
    this.daemonAnswer = daemonAnswer;
    this.registered =
      options.initiallyRegistered === false ? undefined : { ...daemonRecord(), ...options.record };
    this.ensureRunning = vi.fn(async () => {
      if (options.ensureFailure !== undefined) throw options.ensureFailure;
      this.registered = daemonRecord("replacement");
      return {
        status: "ready" as const,
        workspaceRoot,
        fileCount: 1,
        loadDurationMs: 10,
      };
    });
    this.runtime = {
      coordinator: { ensureRunning: this.ensureRunning },
      registry: {
        read: () => {
          this.registryReadCount += 1;
          if (this.options.registryReadFailures?.includes(this.registryReadCount) === true) {
            throw new Error("registry read failed");
          }
          return this.registered;
        },
        removeIfInstance: (identity, instanceId) => {
          this.removeIfInstance(identity, instanceId);
          if (this.removalFailure !== undefined) throw this.removalFailure;
          this.registered = undefined;
        },
      },
      transport: {
        request: async (_endpoint: string, daemonRequest: DaemonRequest) => {
          this.requests.push(daemonRequest);
          if (daemonRequest.kind === "kill") {
            if (this.killFailure !== undefined) throw this.killFailure;
            return {
              kind: "killing",
              instanceId: daemonRequest.instanceId,
              processToken: daemonRequest.processToken,
            };
          }
          if (this.daemonAnswer instanceof Error) throw this.daemonAnswer;
          return {
            kind: "result",
            requestId: daemonRequest.kind === "execute" ? daemonRequest.requestId : "unexpected",
            result: this.daemonAnswer,
          } satisfies DaemonResponse;
        },
      },
    };
  }

  dispatcher(): DaemonCommandDispatcher {
    return new DaemonCommandDispatcher({
      createDependencies: () =>
        ({
          symnavVersion: "0.1.0",
          recorder: { record: this.recordTelemetry },
        }) as unknown as ProgramDependencies,
      daemonEnabled: () => this.options.daemonEnabled ?? true,
      stateDirectory: "/state",
      resolveWorkspaceRoot: async () => workspaceRoot,
      runtimeFactory: this.runtimeFactory,
      executorFactory: () => ({ execute: this.coldExecute }),
      requestId: () => "request-1",
    });
  }

  executeRequests(): readonly DaemonRequest[] {
    return this.requests.filter((daemonRequest) => daemonRequest.kind === "execute");
  }

  answer(daemonAnswer: CommandExecutionResult | Error): void {
    this.daemonAnswer = daemonAnswer;
  }

  registeredRecord(): DaemonRecord | undefined {
    return this.registered;
  }

  failKill(error: Error): void {
    this.killFailure = error;
  }

  failRemoval(error: Error): void {
    this.removalFailure = error;
  }
}

function daemonRecord(instanceId = "instance-1"): DaemonRecord {
  return {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    workspaceRoot,
    workspaceKey: "key",
    stateKey: "state-key",
    identityKey: "identity-key",
    instanceId,
    processToken: `${instanceId}-token`,
    endpoint: "/endpoint",
    pid: 123,
    state: "ready",
    startedAt: 1,
    readyAt: 2,
    fileCount: 1,
    memoryCapBytes: 1024,
  };
}

function telemetryInput(executionMode: "warm" | "cold" | "fallback"): UsageEventInput {
  return {
    symnavVersion: "0.1.0",
    command: "overview",
    timestamp: 1,
    durationMs: 2,
    executionMode,
    outcome: "success",
    argShape: { kind: "path", lengthBucket: "short", flags: [] },
    resultCounts: { symbols: 1 },
    workspaceId: "workspace",
    machineId: "machine",
  };
}
