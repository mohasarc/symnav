import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import { createDefaultDependencies } from "../program.js";
import type {
  DaemonExecutionServerFrame,
  DaemonExecutionStatusResponse,
  DaemonRequest,
  DaemonResponse,
  DaemonServer,
} from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_RECORD_SCHEMA_VERSION } from "./daemon-protocol.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";
import type {
  DaemonNavigationWorker,
  DaemonNavigationWorkerExit,
} from "./daemon-navigation-worker.js";
import type { DaemonNavigationWorkerResponse } from "./daemon-navigation-worker-protocol.js";
import { WorkspaceDaemon } from "./workspace-daemon.js";

describe("WorkspaceDaemon requests", () => {
  const harnesses: RequestHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.map((harness) => harness.dispose()));
    harnesses.length = 0;
  });

  it("authorizes startup before listening and publishes readiness", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    expect(harness.transport.isListening).toBe(true);
    expect(harness.registry.read(harness.identity)).toMatchObject({
      state: "ready",
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      fileCount: 1,
    });
  });

  it("binds lifecycle transport while navigation initialization is blocked", async () => {
    const worker = new DeferredInitializationWorker();
    const { daemon, harness, lease } = RequestHarness.create(undefined, {
      navigationWorker: worker,
    });
    harnesses.push(harness);

    const starting = daemon.start();
    await worker.initializationStarted;

    expect(harness.transport.isListening).toBe(true);
    await expect(harness.ping()).resolves.toMatchObject({ kind: "pong", state: "starting" });
    expect(harness.registry.read(harness.identity)?.state).toBe("starting");

    worker.completeInitialization();
    await starting;
    lease.release();
    expect(harness.registry.read(harness.identity)?.state).toBe("ready");
  });

  it("claims and heartbeats daemon ownership throughout blocked initialization", async () => {
    const worker = new DeferredInitializationWorker();
    const { daemon, harness } = RequestHarness.create(undefined, {
      navigationWorker: worker,
      startupHeartbeatIntervalMs: 5,
    });
    harnesses.push(harness);

    const starting = daemon.start();
    await worker.initializationStarted;
    const claimedOwner = harness.registry.startupOwner(harness.identity);
    expect(claimedOwner).toMatchObject({
      ownerKind: "daemon",
      ownerPid: process.pid,
      processToken: harness.processToken,
    });

    await waitUntil(
      () => harness.registry.startupOwner(harness.identity)?.revision !== claimedOwner?.revision,
    );

    worker.completeInitialization();
    await starting;
    expect(harness.registry.read(harness.identity)?.state).toBe("ready");
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
  });

  it("claims startup from an exact live launcher despite an old heartbeat", async () => {
    const { daemon, harness } = RequestHarness.create(new ImmediateExecutor());
    harnesses.push(harness);
    const owner = harness.registry.startupOwner(harness.identity);
    if (owner === undefined) throw new Error("Expected startup owner");
    writeFileSync(
      harness.identity.startupOwnerPath(harness.identity.lockPath),
      JSON.stringify({ ...owner, acquiredAt: 1, heartbeatAt: 1 }),
    );

    await expect(daemon.start()).resolves.toBeUndefined();
    expect(harness.registry.read(harness.identity)?.state).toBe("ready");
  });

  it("waits through the registry mutation grace for startup authorization", async () => {
    let claimAttempts = 0;
    const { daemon, harness } = RequestHarness.create(new ImmediateExecutor(), {
      now: () => claimAttempts * 1_000,
    });
    harnesses.push(harness);
    const claimStartupForDaemon = harness.registry.claimStartupForDaemon.bind(harness.registry);
    vi.spyOn(harness.registry, "claimStartupForDaemon").mockImplementation((...arguments_) => {
      claimAttempts += 1;
      if (claimAttempts <= 6) return undefined;
      return claimStartupForDaemon(...arguments_);
    });

    await expect(daemon.start()).resolves.toBeUndefined();

    expect(claimAttempts).toBe(7);
    expect(harness.registry.read(harness.identity)?.state).toBe("ready");
  });

  it("cleans exact starting ownership when worker initialization fails", async () => {
    const worker = new RejectingInitializationWorker();
    const { daemon, harness } = RequestHarness.create(undefined, { navigationWorker: worker });
    harnesses.push(harness);

    await expect(daemon.start()).rejects.toThrow("initialization failed");

    expect(worker.terminateCount).toBe(1);
    expect(harness.transport.isListening).toBe(false);
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
    expect(
      harness.registry.readStoredInstance(harness.identity, harness.instanceId),
    ).toBeUndefined();
  });

  it("authenticates identity requests", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await expect(
      harness.transport.receive({
        kind: "identify",
        instanceId: harness.instanceId,
        processToken: "wrong-token",
      }),
    ).rejects.toThrow("identity request");
    await expect(harness.identify()).resolves.toMatchObject({
      kind: "identity",
      instanceId: harness.instanceId,
      processToken: harness.processToken,
    });
  });

  it("authenticates termination requests", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await expect(
      harness.transport.receive({
        kind: "terminate",
        instanceId: harness.instanceId,
        processToken: "wrong-token",
      }),
    ).rejects.toThrow("termination");
    await expect(harness.terminate()).resolves.toEqual({
      kind: "terminating",
      instanceId: harness.instanceId,
      processToken: harness.processToken,
    });
  });

  it("reports protocol and process identity to matching pings", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await expect(harness.ping()).resolves.toMatchObject({
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: harness.instanceId,
      symnavVersion: "test",
    });
  });

  it("reports workspace status metrics in daemon pings", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await expect(harness.ping()).resolves.toMatchObject({
      startedAt: expect.any(Number),
      fileCount: 1,
      memoryBytes: expect.any(Number),
    });
  });

  it("executes matching workspace requests", async () => {
    const executor = new RecordingExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);

    await expect(harness.execute("one")).resolves.toEqual({
      kind: "completed",
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      requestId: "one",
      result: { frames: [], exitCode: 0 },
    });
    expect(executor.requests).toHaveLength(1);
  });

  it("timestamps daemon requests when they are accepted", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor(), { now: () => 1_234 });
    harnesses.push(harness);

    await harness.execute("timestamped");

    await expect(harness.ping()).resolves.toMatchObject({ lastNavigationAt: 1_234 });
  });

  it("serializes workspace execution requests", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);

    const first = harness.execute("first");
    await executor.started(1);
    const second = harness.execute("second");
    await Promise.resolve();
    expect(executor.startedCount).toBe(1);
    executor.complete(0);
    await first;
    await executor.started(2);
    executor.complete(1);
    await second;
  });

  it("executes disconnected active and queued accepted requests once in FIFO order", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);

    const first = await harness.admit("first", ["overview", "first.ts"]);
    await executor.started(1);
    const second = await harness.admit("second", ["overview", "second.ts"]);
    first.disconnect();
    second.disconnect();

    executor.complete(0);
    await executor.started(2);
    executor.complete(1);
    await waitUntil(async () => (await harness.status("second")).status.state === "completed");

    expect(executor.requests.map((execution) => execution.argv.at(-1))).toEqual([
      "first.ts",
      "second.ts",
    ]);
    expect(first.frames).toHaveLength(1);
    expect(second.frames).toHaveLength(1);
  });

  it("attaches identical duplicate identifiers without duplicate execution", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);

    const first = await harness.admit("duplicate", ["overview", "input.ts"]);
    await executor.started(1);
    const duplicate = await harness.admit("duplicate", ["overview", "input.ts"]);
    const corrupted = await harness.admit("duplicate", ["overview", "other.ts"]);
    executor.complete(0);
    await Promise.all([first.terminal, duplicate.terminal]);

    expect(executor.startedCount).toBe(1);
    expect(first.frames.map((frame) => frame.kind)).toEqual(["accepted", "completed"]);
    expect(duplicate.frames.map((frame) => frame.kind)).toEqual(["accepted", "completed"]);
    expect(corrupted.frames).toEqual([
      expect.objectContaining({ kind: "rejected", retrySafe: false }),
    ]);
  });

  it("reports unknown, queued, running, completed, and failed execution status", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);

    expect((await harness.status("missing")).status).toEqual({ state: "unknown" });
    const active = await harness.admit("active");
    await executor.started(1);
    expect((await harness.status("active")).status).toMatchObject({ state: "running" });
    const queued = await harness.admit("queued");
    expect((await harness.status("queued")).status).toMatchObject({
      state: "queued",
      queuePosition: 1,
    });
    executor.complete(0);
    await executor.started(2);
    executor.complete(1);
    await Promise.all([active.terminal, queued.terminal]);
    expect((await harness.status("active")).status).toEqual({ state: "completed" });

    const failedHarness = await RequestHarness.start(new RejectingExecutor());
    harnesses.push(failedHarness);
    const failed = await failedHarness.admit("failed");
    await failed.terminal;
    expect((await failedHarness.status("failed")).status).toEqual({
      state: "failed",
      code: "internal",
    });
  });

  it("reports active command and queued count while worker execution is blocked", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);
    const first = harness.execute("first", ["refs", "input"]);
    await executor.started(1);
    const second = harness.execute("second", ["overview", "input.ts"]);

    const pingStartedAt = Date.now();
    await expect(harness.ping()).resolves.toMatchObject({
      kind: "pong",
      state: "busy",
      currentCommand: "refs",
      queued: 1,
    });
    expect(Date.now() - pingStartedAt).toBeLessThan(1_000);

    executor.complete(0);
    await first;
    await executor.started(2);
    executor.complete(1);
    await second;
  });

  it("acknowledges graceful stop requests", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await expect(harness.stop()).resolves.toEqual({
      kind: "stopped",
      instanceId: harness.instanceId,
    });
  });

  it("force-terminates blocked worker execution with one controlled result", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);
    const execution = harness.execute("blocked", ["refs", "input"]);
    await executor.started(1);

    await expect(harness.kill()).resolves.toEqual({
      kind: "killing",
      instanceId: harness.instanceId,
      processToken: harness.processToken,
    });
    await expect(execution).resolves.toEqual({
      kind: "execution-failed",
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      requestId: "blocked",
      code: "stopping",
    });
    await harness.exited;
    expect(harness.registry.read(harness.identity)).toMatchObject({
      processToken: harness.processToken,
    });
  });

  it("closes transport while leaving ready ownership for an exit observer", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await harness.stop();
    await harness.exited;

    expect(harness.registry.read(harness.identity)).toMatchObject({
      processToken: harness.processToken,
    });
    expect(harness.transport.isListening).toBe(false);
  });

  it("records worker freshness diagnostics for every execution turn", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await harness.execute("refresh", ["overview", "input.ts"]);

    expect(harness.logEvents().filter((event) => event.kind === "freshness")).toHaveLength(2);
  });

  it("logs startup failures before rethrowing them", async () => {
    const { daemon, harness, lease } = RequestHarness.create(new ImmediateExecutor());
    harnesses.push(harness);
    harness.transport.listenError = new Error("listen failed");

    await expect(daemon.start()).rejects.toThrow("listen failed");
    lease.release();

    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "failure", operation: "start", message: "listen failed" }),
      ]),
    );
  });

  it("does not mutate registry ownership during process-local shutdown", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);
    const remove = vi.spyOn(harness.registry, "removeIfProcess");

    await harness.stop();
    await harness.exited;

    expect(harness.transport.isListening).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("exits after transport cleanup fails", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);
    harness.transport.closeError = new Error("transport cleanup failed");

    await harness.stop();
    await harness.exited;

    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "failure",
          operation: "transport-close",
          message: "transport cleanup failed",
        }),
      ]),
    );
  });

  it("shuts down when the navigation worker exits unexpectedly", async () => {
    const worker = new ExecutorNavigationWorker(new ImmediateExecutor());
    const harness = await RequestHarness.start(undefined, { navigationWorker: worker });
    harnesses.push(harness);

    worker.fail({ generation: worker.generation, cause: "error", errorName: "WorkerError" });

    await expect(harness.exited).resolves.toBe(0);
    expect(harness.transport.isListening).toBe(false);
    expect(harness.registry.read(harness.identity)).toMatchObject({
      processToken: harness.processToken,
    });
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "failure",
          operation: "worker-exit",
          message: "error (WorkerError)",
        }),
      ]),
    );
  });
});

class RequestHarness {
  readonly stateDirectory = mkdtempSync(join(tmpdir(), "symnav-request-state-"));
  readonly workspaceRoot = mkdtempSync(join(tmpdir(), "symnav-request-workspace-"));
  readonly identity: DaemonWorkspaceIdentity;
  readonly registry: DaemonRegistry;
  readonly transport = new RequestTransport();
  readonly instanceId = "request-instance";
  readonly processToken = "request-token";
  readonly exited: Promise<number>;
  private resolveExit!: (code: number) => void;

  private constructor() {
    mkdirSync(join(this.workspaceRoot, ".git"));
    writeFileSync(join(this.workspaceRoot, "input.ts"), "export const value = 1;\n");
    this.identity = DaemonWorkspaceIdentity.from(this.workspaceRoot, this.stateDirectory);
    this.registry = new DaemonRegistry(this.identity.registryDirectory);
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  static async start(
    executor: DaemonCommandExecutor | undefined,
    options: RequestHarnessOptions = {},
  ): Promise<RequestHarness> {
    const { daemon, harness, lease } = RequestHarness.create(executor, options);
    await daemon.start();
    lease.release();
    return harness;
  }

  static create(
    executor: DaemonCommandExecutor | undefined,
    options: RequestHarnessOptions = {},
  ): {
    readonly daemon: WorkspaceDaemon;
    readonly harness: RequestHarness;
    readonly lease: NonNullable<ReturnType<DaemonRegistry["acquireStartup"]>>;
  } {
    const harness = new RequestHarness();
    const lease = harness.registry.acquireStartup(harness.identity, {
      identityKey: harness.identity.identityKey,
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      ownerPid: process.pid,
      ownerKind: "launcher",
      heartbeatAt: Date.now(),
    });
    if (lease === undefined) throw new Error("Expected startup ownership");
    harness.registry.write({
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: "test",
      workspaceRoot: harness.workspaceRoot,
      workspaceKey: harness.identity.workspaceKey,
      stateKey: harness.identity.stateKey,
      identityKey: harness.identity.identityKey,
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      endpoint: harness.identity.endpoint(harness.instanceId),
      pid: process.pid,
      state: "starting",
      startedAt: Date.now(),
      memoryCapBytes: 1024,
    });
    const daemon = new WorkspaceDaemon({
      identity: harness.identity,
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      symnavVersion: "test",
      memoryCapBytes: 1024,
      dependencies: createDefaultDependencies(harness.identity.stateDirectory),
      registry: harness.registry,
      transport: harness.transport as unknown as LocalDaemonTransport,
      navigationWorker:
        options.navigationWorker ??
        new ExecutorNavigationWorker(executor ?? new ImmediateExecutor()),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.startupHeartbeatIntervalMs === undefined
        ? {}
        : { startupHeartbeatIntervalMs: options.startupHeartbeatIntervalMs }),
      exit: (code) => harness.resolveExit(code),
    });
    return { daemon, harness, lease };
  }

  identify(): Promise<DaemonResponse> {
    return this.transport.receive({
      kind: "identify",
      instanceId: this.instanceId,
      processToken: this.processToken,
    });
  }

  terminate(): Promise<DaemonResponse> {
    return this.transport.receive({
      kind: "terminate",
      instanceId: this.instanceId,
      processToken: this.processToken,
    });
  }

  ping(): Promise<DaemonResponse> {
    return this.transport.receive({
      kind: "ping",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
    });
  }

  execute(requestId: string, argv: readonly string[] = ["--version"]): Promise<DaemonResponse> {
    return this.admit(requestId, argv).then((connection) => connection.terminal);
  }

  admit(requestId: string, argv: readonly string[] = ["--version"]): Promise<RequestConnection> {
    return this.transport.connect({
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      processToken: this.processToken,
      requestId,
      request: { argv, cwd: this.workspaceRoot, telemetryEnabled: false },
    });
  }

  status(requestId: string): Promise<DaemonExecutionStatusResponse> {
    return this.transport.receive({
      kind: "execution-status",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      processToken: this.processToken,
      requestId,
    }) as Promise<DaemonExecutionStatusResponse>;
  }

  stop(): Promise<DaemonResponse> {
    return this.transport.receive({
      kind: "stop",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
    });
  }

  kill(): Promise<DaemonResponse> {
    return this.transport.receive({
      kind: "kill",
      instanceId: this.instanceId,
      processToken: this.processToken,
    });
  }

  logEvents(): readonly Record<string, unknown>[] {
    return readFileSync(this.identity.logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  async dispose(): Promise<void> {
    if (this.transport.isListening) {
      await this.transport
        .receive({ kind: "kill", instanceId: this.instanceId, processToken: this.processToken })
        .catch(() => undefined);
      await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 100))]);
    }
    rmSync(this.stateDirectory, { recursive: true, force: true });
    rmSync(this.workspaceRoot, { recursive: true, force: true });
  }
}

interface RequestHarnessOptions {
  readonly now?: () => number;
  readonly navigationWorker?: DaemonNavigationWorker;
  readonly startupHeartbeatIntervalMs?: number;
}

class RequestTransport {
  private handler:
    | ((
        request: DaemonRequest,
        send: (response: DaemonResponse) => void,
      ) => Promise<DaemonResponse | void>)
    | undefined;
  listenError: Error | undefined;
  closeError: Error | undefined;

  get isListening(): boolean {
    return this.handler !== undefined;
  }

  async listen(
    _endpoint: string,
    handler: (
      request: DaemonRequest,
      send: (response: DaemonResponse) => void,
    ) => Promise<DaemonResponse | void>,
  ): Promise<DaemonServer> {
    if (this.listenError !== undefined) throw this.listenError;
    this.handler = handler;
    return {
      close: async () => {
        this.handler = undefined;
        if (this.closeError !== undefined) throw this.closeError;
      },
    };
  }

  async receive(request: DaemonRequest): Promise<DaemonResponse> {
    if (this.handler === undefined) return Promise.reject(new Error("Transport is not listening"));
    const response = await this.handler(request, () => undefined);
    if (response === undefined) throw new Error("Transport handler returned no response");
    return response;
  }

  async connect(request: DaemonRequest): Promise<RequestConnection> {
    if (this.handler === undefined) throw new Error("Transport is not listening");
    const frames: DaemonExecutionServerFrame[] = [];
    let connected = true;
    let resolveTerminal!: (frame: DaemonExecutionServerFrame) => void;
    const terminal = new Promise<DaemonExecutionServerFrame>((resolve) => {
      resolveTerminal = resolve;
    });
    const receive = (response: DaemonResponse): void => {
      if (!connected || !RequestTransport.isExecutionFrame(response)) return;
      frames.push(response);
      if (
        response.kind === "rejected" ||
        response.kind === "completed" ||
        response.kind === "execution-failed"
      ) {
        resolveTerminal(response);
      }
    };
    const response = await this.handler(request, receive);
    if (response !== undefined) receive(response);
    return {
      frames,
      terminal,
      disconnect: () => {
        connected = false;
      },
    };
  }

  private static isExecutionFrame(response: DaemonResponse): response is DaemonExecutionServerFrame {
    return (
      response.kind === "accepted" ||
      response.kind === "rejected" ||
      response.kind === "completed" ||
      response.kind === "execution-failed"
    );
  }
}

interface RequestConnection {
  readonly frames: DaemonExecutionServerFrame[];
  readonly terminal: Promise<DaemonExecutionServerFrame>;
  disconnect(): void;
}

interface DaemonCommandExecutor {
  execute(request: CliExecutionRequest): Promise<CommandExecutionResult>;
}

class ImmediateExecutor implements DaemonCommandExecutor {
  async execute(_request: CliExecutionRequest): Promise<CommandExecutionResult> {
    return { frames: [], exitCode: 0 };
  }
}

class RecordingExecutor implements DaemonCommandExecutor {
  readonly requests: CliExecutionRequest[] = [];

  async execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    this.requests.push(request);
    return { frames: [], exitCode: 0 };
  }
}

class SerializedExecutor implements DaemonCommandExecutor {
  private readonly results: (() => void)[] = [];
  readonly requests: CliExecutionRequest[] = [];

  get startedCount(): number {
    return this.results.length;
  }

  async execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    this.requests.push(request);
    await new Promise<void>((resolve) => this.results.push(resolve));
    return { frames: [], exitCode: 0 };
  }

  async started(count: number): Promise<void> {
    while (this.results.length < count) await Promise.resolve();
  }

  complete(index: number): void {
    this.results[index]?.();
  }
}

class RejectingExecutor implements DaemonCommandExecutor {
  execute(): Promise<CommandExecutionResult> {
    return Promise.reject(new Error("execution failed"));
  }
}

class ExecutorNavigationWorker implements DaemonNavigationWorker {
  readonly generation = 1;
  readonly exited: Promise<DaemonNavigationWorkerExit>;
  private resolveExited!: (exit: DaemonNavigationWorkerExit) => void;
  private rejectTermination!: (error: Error) => void;
  private readonly termination: Promise<never>;

  constructor(private readonly executor: DaemonCommandExecutor) {
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.termination = new Promise((_resolve, reject) => {
      this.rejectTermination = reject;
    });
    void this.termination.catch(() => undefined);
  }

  async start(): Promise<DaemonNavigationWorkerResponse> {
    return {
      kind: "ready",
      generation: this.generation,
      fileCount: 1,
      refresh: { added: 1, changed: 0, removed: 0, unchanged: 0 },
      startupDurations: { discoveryMs: 0, indexingMs: 1, totalMs: 1 },
    };
  }

  async execute(
    requestId: string,
    request: CliExecutionRequest,
  ): Promise<DaemonNavigationWorkerResponse> {
    return {
      kind: "result",
      generation: this.generation,
      requestId,
      result: await Promise.race([this.executor.execute(request), this.termination]),
      refresh: { added: 0, changed: 0, removed: 0, unchanged: 1 },
      durations: { freshnessMs: 0, navigationMs: 1, renderMs: 0, outputMs: 0 },
    };
  }

  async releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    return { kind: "heap", generation: this.generation, usedHeapBytes: 1, heapLimitBytes: 2 };
  }

  drainAndClose(): Promise<void> {
    this.resolveExited({ generation: this.generation, cause: "closed" });
    return Promise.resolve();
  }

  terminate(): Promise<void> {
    this.rejectTermination(new Error("worker terminated"));
    this.resolveExited({ generation: this.generation, cause: "terminated" });
    return Promise.resolve();
  }

  fail(exit: DaemonNavigationWorkerExit): void {
    this.resolveExited(exit);
  }
}

class DeferredInitializationWorker implements DaemonNavigationWorker {
  readonly generation = 1;
  readonly exited = new Promise<DaemonNavigationWorkerExit>(() => undefined);
  readonly initializationStarted: Promise<void>;
  private resolveInitializationStarted!: () => void;
  private resolveReady!: (response: DaemonNavigationWorkerResponse) => void;
  private readonly ready: Promise<DaemonNavigationWorkerResponse>;

  constructor() {
    this.initializationStarted = new Promise((resolve) => {
      this.resolveInitializationStarted = resolve;
    });
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  start(): Promise<DaemonNavigationWorkerResponse> {
    this.resolveInitializationStarted();
    return this.ready;
  }

  execute(): Promise<DaemonNavigationWorkerResponse> {
    throw new Error("Deferred initialization worker is not executable");
  }

  releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    throw new Error("Deferred initialization worker has no transient resources");
  }

  drainAndClose(): Promise<void> {
    return Promise.resolve();
  }

  terminate(): Promise<void> {
    return Promise.resolve();
  }

  completeInitialization(): void {
    this.resolveReady({
      kind: "ready",
      generation: this.generation,
      fileCount: 1,
      refresh: { added: 1, changed: 0, removed: 0, unchanged: 0 },
      startupDurations: { discoveryMs: 0, indexingMs: 1, totalMs: 1 },
    });
  }
}

class RejectingInitializationWorker extends DeferredInitializationWorker {
  terminateCount = 0;

  override start(): Promise<DaemonNavigationWorkerResponse> {
    return Promise.reject(new Error("initialization failed"));
  }

  override terminate(): Promise<void> {
    this.terminateCount += 1;
    return Promise.resolve();
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for daemon startup state");
}
