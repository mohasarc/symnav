import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import {
  CommandOutputSnapshot,
  type CliExecutionRequest,
  type CommandExecutionResult,
} from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import {
  DaemonCommandDispatcher,
  type DaemonDispatchRuntime,
} from "./daemon-command-dispatcher.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonExecuteRequest,
  type DaemonPong,
  type DaemonRecord,
} from "./daemon-protocol.js";
import type { DaemonObservation } from "./daemon-record-observer.js";
import { DaemonTransportError } from "./local-daemon-transport.js";

const workspaceRoot = resolve("synthetic-workspace");
const request: CliExecutionRequest = {
  argv: ["overview", "src/a.ts"],
  cwd: workspaceRoot,
  telemetryEnabled: false,
};
const success: CommandExecutionResult = {
  output: new CommandOutputSnapshot([{ stream: "stdout", bytes: Buffer.from("answer\n") }]),
  exitCode: 0,
};

describe("DaemonCommandDispatcher", () => {
  it.each([
    ["ready idle", { pongState: "ready" as const }, "warm", 0, 1, 0, 0],
    ["ready busy", { pongState: "busy" as const }, "warm", 0, 1, 0, 0],
    ["absent", { initiallyRegistered: false }, "cold", 1, 0, 1, 0],
    [
      "starting",
      { record: { state: "starting" as const, readyAt: undefined, fileCount: undefined } },
      "cold",
      1,
      0,
      0,
      0,
    ],
    ["recovering", { observationKind: "unresponsive" as const }, "cold", 1, 0, 0, 0],
    ["confirmed dead", { observationKind: "exited" as const }, "fallback", 1, 0, 1, 1],
    ["incompatible", { record: { symnavVersion: "0.0.9" } }, "fallback", 1, 0, 1, 0],
    ["disabled", { daemonEnabled: false }, "cold", 1, 0, 0, 0],
  ])(
    "routes %s through exactly one executor",
    async (_name, options, mode, localExecutions, warmExecutions, triggers, removals) => {
      const harness = new DispatchHarness(success, options as DispatchHarnessOptions);

      await expect(harness.dispatcher().execute(request)).resolves.toMatchObject({ mode });

      expect(harness.coldExecute).toHaveBeenCalledTimes(localExecutions as number);
      expect(harness.executeRequests()).toHaveLength(warmExecutions as number);
      expect(harness.trigger).toHaveBeenCalledTimes(triggers as number);
      expect(harness.removeIfProcess).toHaveBeenCalledTimes(removals as number);
    },
  );

  it.each([
    ["absent", { initiallyRegistered: false }],
    ["incompatible", { record: { symnavVersion: "0.0.9" } }],
  ])("does not await a never-resolving %s trigger", async (_name, options) => {
    const harness = new DispatchHarness(success, {
      ...options,
      triggerResult: new Promise(() => {}),
    });

    await expect(harness.dispatcher().execute(request)).resolves.toMatchObject({ result: success });

    expect(harness.trigger).toHaveBeenCalledOnce();
    expect(harness.coldExecute).toHaveBeenCalledOnce();
  });

  it("keeps a cold route after readiness publishes", async () => {
    const harness = new DispatchHarness(success, {
      initiallyRegistered: false,
      publishReadyWhenTriggered: true,
    });

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "cold",
      result: success,
    });

    expect(harness.executeRequests()).toHaveLength(0);
    expect(harness.coldExecute).toHaveBeenCalledOnce();
  });

  it("falls back once after authenticated warm pre-admission failure", async () => {
    const harness = new DispatchHarness(
      new DaemonTransportError("unreachable", "not-submitted", "connection refused"),
    );

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "fallback",
      result: success,
    });

    expect(harness.coldExecute).toHaveBeenCalledOnce();
    expect(harness.removeIfProcess).not.toHaveBeenCalled();
    expect(harness.trigger).not.toHaveBeenCalled();
  });

  it.each([
    new DaemonTransportError("timeout", "submitted-unconfirmed", "request timed out"),
    new DaemonTransportError("closed", "accepted", "request closed", "instance-1"),
    new DaemonTransportError(
      "rejected",
      "submitted-unconfirmed",
      "non-retry rejection",
      "instance-1",
      false,
    ),
    new Error("malformed accepted completion"),
  ])(
    "returns a controlled result without replay or mutation after uncertain delivery %#",
    async (failure) => {
      const harness = new DispatchHarness(failure);

      await expect(harness.dispatcher().execute(request)).resolves.toMatchObject({
        mode: "warm",
        result: { exitCode: 1, output: expect.any(CommandOutputSnapshot) },
      });

      expect(harness.coldExecute).not.toHaveBeenCalled();
      expect(harness.removeIfProcess).not.toHaveBeenCalled();
      expect(harness.trigger).not.toHaveBeenCalled();
    },
  );

  it("returns a controlled result without replay for a malformed completion", async () => {
    const harness = new DispatchHarness({ output: new CommandOutputSnapshot([]), exitCode: 1.5 });

    await expect(harness.dispatcher().execute(request)).resolves.toMatchObject({
      mode: "warm",
      result: { exitCode: 1 },
    });

    expect(harness.coldExecute).not.toHaveBeenCalled();
  });

  it("falls back once after an authenticated retry-safe rejection", async () => {
    const harness = new DispatchHarness(
      new DaemonTransportError(
        "rejected",
        "submitted-unconfirmed",
        "not ready",
        "instance-1",
        true,
      ),
    );

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "fallback",
      result: success,
    });

    expect(harness.coldExecute).toHaveBeenCalledOnce();
    expect(harness.removeIfProcess).not.toHaveBeenCalled();
  });

  it.each(["worker-exit", "controlled-resource", "response-capacity", "stopping", "internal"])(
    "returns one controlled result and never replays terminal daemon failure %s",
    async (code) => {
      const harness = new DispatchHarness({ failed: code as DaemonFailureCode });

      await expect(harness.dispatcher().execute(request)).resolves.toMatchObject({
        mode: "warm",
        result: { exitCode: 1 },
      });

      expect(harness.coldExecute).not.toHaveBeenCalled();
      expect(harness.removeIfProcess).not.toHaveBeenCalled();
    },
  );

  it("does not mutate or trigger from an unresponsive observation", async () => {
    const harness = new DispatchHarness(success, { observationKind: "unresponsive" });

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "cold",
      result: success,
    });

    expect(harness.removeIfProcess).not.toHaveBeenCalled();
    expect(harness.trigger).not.toHaveBeenCalled();
    expect(harness.executeRequests()).toHaveLength(0);
  });

  it("sends an absolute cwd override to the selected warm daemon", async () => {
    const harness = new DispatchHarness(success);

    await harness.dispatcher().execute({
      ...request,
      argv: ["--cwd", "..", ...request.argv],
      cwd: join(workspaceRoot, "nested"),
    });

    expect(harness.executeRequests()).toEqual([
      expect.objectContaining({
        commandName: "overview",
        request: expect.objectContaining({ argv: ["--cwd", workspaceRoot, ...request.argv] }),
      }),
    ]);
  });

  it("never records warm telemetry in the caller", async () => {
    const harness = new DispatchHarness(success);

    await expect(
      harness.dispatcher().execute({ ...request, telemetryEnabled: true }),
    ).resolves.toEqual({ mode: "warm", result: success });

    expect(harness.recordTelemetry).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled", { daemonEnabled: false }, "cold"],
    ["absent", { initiallyRegistered: false }, "cold"],
    ["dead", { observationKind: "exited" as const }, "fallback"],
  ])("attributes %s telemetry to the actual local route", async (_name, options, executionMode) => {
    const harness = new DispatchHarness(success, options as DispatchHarnessOptions);

    await harness.dispatcher().execute({ ...request, telemetryEnabled: true });

    expect(harness.coldExecute).toHaveBeenCalledWith(expect.objectContaining({ executionMode }));
  });
});

interface DispatchHarnessOptions {
  readonly daemonEnabled?: boolean;
  readonly initiallyRegistered?: boolean;
  readonly record?: Partial<DaemonRecord>;
  readonly observationKind?: DaemonObservation["kind"];
  readonly pongState?: DaemonPong["state"];
  readonly triggerResult?: Promise<unknown>;
  readonly publishReadyWhenTriggered?: boolean;
}

class DispatchHarness {
  readonly trigger: ReturnType<typeof vi.fn>;
  readonly removeIfProcess = vi.fn();
  readonly observe = vi.fn();
  readonly coldExecute = vi.fn(async () => success);
  readonly recordTelemetry = vi.fn();
  readonly runtimeFactory = vi.fn(() => this.runtime);
  private readonly requests: DaemonExecuteRequest[] = [];
  private registered: DaemonRecord | undefined;
  private readonly runtime: DaemonDispatchRuntime;

  constructor(
    private readonly daemonAnswer:
      | CommandExecutionResult
      | Error
      | { readonly failed: DaemonFailureCode },
    private readonly options: DispatchHarnessOptions = {},
  ) {
    this.registered =
      options.initiallyRegistered === false ? undefined : { ...daemonRecord(), ...options.record };
    this.trigger = vi.fn(() => {
      if (options.publishReadyWhenTriggered) this.registered = daemonRecord("replacement");
      return options.triggerResult ?? Promise.resolve({ status: "launched" });
    });
    this.observe.mockImplementation(async (record: DaemonRecord): Promise<DaemonObservation> => {
      const kind = this.options.observationKind ?? "responsive";
      if (kind === "exited" || kind === "starting") return { kind, record };
      if (kind === "responsive") {
        return {
          kind,
          record,
          pong: {
            kind: "pong",
            protocolVersion: record.protocolVersion,
            instanceId: record.instanceId,
            symnavVersion: record.symnavVersion,
            state: this.options.pongState ?? "ready",
          },
        };
      }
      if (kind === "unresponsive") return { kind, record, failureCode: "timeout" };
      return {
        kind,
        record,
        evidence: {
          instanceId: record.instanceId,
          processToken: record.processToken,
          pid: record.pid,
          startedAt: record.startedAt,
        },
      };
    });
    this.runtime = {
      coordinator: { trigger: this.trigger },
      observer: { observe: this.observe },
      registry: {
        read: () => this.registered,
        removeIfProcess: (identity, instanceId, processToken) => {
          this.removeIfProcess(identity, instanceId, processToken);
          this.registered = undefined;
          return true;
        },
      },
      transport: {
        execute: async (_endpoint, daemonRequest) => {
          this.requests.push(daemonRequest);
          if (this.daemonAnswer instanceof Error) throw this.daemonAnswer;
          return {
            acceptance: {
              requestId: daemonRequest.requestId,
              instanceId: daemonRequest.instanceId,
              acceptedAt: 1,
              queuePosition: 0,
            },
            completion:
              "failed" in this.daemonAnswer
                ? Promise.resolve({ status: "failed" as const, code: this.daemonAnswer.failed })
                : Promise.resolve({ status: "completed" as const, result: this.daemonAnswer }),
          };
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
      policy: DaemonPolicy.currentSystem(),
      resolveWorkspaceRoot: async () => workspaceRoot,
      runtimeFactory: this.runtimeFactory,
      executorFactory: () => ({ execute: this.coldExecute }),
      requestId: () => "request-1",
    });
  }

  executeRequests(): readonly DaemonExecuteRequest[] {
    return this.requests.filter((daemonRequest) => daemonRequest.kind === "execute");
  }
}

type DaemonFailureCode =
  | "worker-exit"
  | "controlled-resource"
  | "response-capacity"
  | "stopping"
  | "internal";

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
