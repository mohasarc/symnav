import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import { createDefaultDependencies } from "../program.js";
import type { DaemonRequest, DaemonResponse, DaemonServer } from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION } from "./daemon-protocol.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";
import { type DaemonCommandExecutor, WorkspaceDaemon } from "./workspace-daemon.js";

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

  it("rejects startup authorization from an expired live owner", async () => {
    let currentTime = 0;
    const { daemon, harness, lease } = RequestHarness.create(new ImmediateExecutor(), {
      now: () => {
        currentTime += 5_001;
        return currentTime;
      },
    });
    harnesses.push(harness);
    const owner = harness.registry.startupOwner(harness.identity);
    if (owner === undefined) throw new Error("Expected startup owner");
    writeFileSync(
      harness.identity.startupOwnerPath(harness.identity.lockPath),
      JSON.stringify({ ...owner, acquiredAt: 1, heartbeatAt: 1 }),
    );

    await expect(daemon.start()).rejects.toThrow("startup authorization");
    lease.release();
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
      kind: "result",
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

  it("acknowledges graceful stop requests", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await expect(harness.stop()).resolves.toEqual({
      kind: "stopped",
      instanceId: harness.instanceId,
    });
  });

  it("removes registry and transport state before exiting", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await harness.stop();
    await harness.exited;

    expect(harness.registry.read(harness.identity)).toBeUndefined();
    expect(harness.transport.isListening).toBe(false);
  });

  it("forwards refresh summaries and records freshness diagnostics", async () => {
    const backendRefreshed = vi.fn();
    const dependencies: ProgramDependencies = { ...createDefaultDependencies(), backendRefreshed };
    const harness = await RequestHarness.start(undefined, { dependencies });
    harnesses.push(harness);

    await harness.execute("refresh", ["overview", "input.ts"]);

    expect(backendRefreshed).toHaveBeenCalledOnce();
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "freshness" })]),
    );
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

  it("closes transport and exits after registry cleanup fails", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);
    harness.failRegistryRemoval();

    await harness.stop();
    await harness.exited;

    expect(harness.transport.isListening).toBe(false);
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "failure",
          operation: "registry-cleanup",
          message: "registry cleanup failed",
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
    const lease = harness.registry.acquireStartup(harness.identity, harness.instanceId);
    if (lease === undefined) throw new Error("Expected startup ownership");
    harness.registry.write({
      schemaVersion: 1,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: "test",
      workspaceRoot: harness.workspaceRoot,
      workspaceKey: harness.identity.workspaceKey,
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
      dependencies: options.dependencies ?? createDefaultDependencies(),
      registry: harness.registry,
      transport: harness.transport as unknown as LocalDaemonTransport,
      ...(executor === undefined ? {} : { executor }),
      ...(options.now === undefined ? {} : { now: options.now }),
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
    return this.transport.receive({
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      requestId,
      request: { argv, cwd: this.workspaceRoot, telemetryEnabled: false },
    });
  }

  stop(): Promise<DaemonResponse> {
    return this.transport.receive({
      kind: "stop",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
    });
  }

  logEvents(): readonly Record<string, unknown>[] {
    return readFileSync(this.identity.logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  failRegistryRemoval(): void {
    vi.spyOn(this.registry, "removeIfInstance").mockImplementation(() => {
      throw new Error("registry cleanup failed");
    });
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
  readonly dependencies?: ProgramDependencies;
  readonly now?: () => number;
}

class RequestTransport {
  private handler: ((request: DaemonRequest) => Promise<DaemonResponse>) | undefined;
  listenError: Error | undefined;
  closeError: Error | undefined;

  get isListening(): boolean {
    return this.handler !== undefined;
  }

  async listen(
    _endpoint: string,
    handler: (request: DaemonRequest) => Promise<DaemonResponse>,
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

  receive(request: DaemonRequest): Promise<DaemonResponse> {
    if (this.handler === undefined) return Promise.reject(new Error("Transport is not listening"));
    return this.handler(request);
  }
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

  get startedCount(): number {
    return this.results.length;
  }

  async execute(_request: CliExecutionRequest): Promise<CommandExecutionResult> {
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
