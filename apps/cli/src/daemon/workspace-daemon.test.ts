import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalStateDir } from "@symnav/telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import { createDefaultDependencies } from "../program.js";
import { DaemonController } from "./daemon-controller.js";
import type { DaemonProcessTerminator } from "./daemon-process-launcher.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonServer,
} from "./daemon-protocol.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";
import { type DaemonCommandExecutor, WorkspaceDaemon } from "./workspace-daemon.js";

describe("WorkspaceDaemon runtime lifecycle", () => {
  const harnesses: WorkspaceDaemonHarness[] = [];
  const childProcesses: ChildProcess[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.map((harness) => harness.dispose()));
    harnesses.length = 0;
    for (const child of childProcesses) child.kill("SIGTERM");
    childProcesses.length = 0;
  });

  it("returns an in-flight navigation result before a graceful stop exits", async () => {
    const executor = new DeferredExecutor();
    const harness = await WorkspaceDaemonHarness.start(executor);
    harnesses.push(harness);
    const execution = harness.execute("navigation");
    await executor.started;
    const stopping = harness.stop();

    executor.complete({
      frames: [{ stream: "stdout", bytesBase64: Buffer.from("result\n").toString("base64") }],
      exitCode: 0,
    });

    await expect(execution).resolves.toMatchObject({
      kind: "result",
      requestId: "navigation",
      result: { exitCode: 0 },
    });
    await expect(stopping).resolves.toEqual({
      kind: "stopped",
      instanceId: harness.instanceId,
    });
    await harness.exited;
    expect(harness.registry.read(harness.identity)).toBeUndefined();
    await expect(harness.ping()).rejects.toThrow();
  });

  it("force-stops a matching daemon with a stuck request inside the bound", async () => {
    const executor = new DeferredExecutor();
    const harness = await WorkspaceDaemonHarness.start(executor);
    harnesses.push(harness);
    void harness.execute("stuck").catch(() => undefined);
    await executor.started;
    const controller = new DaemonController(
      harness.registry,
      harness.transport,
      harness.stateDirectory,
      {
        stopTimeoutMs: 100,
        pollIntervalMs: 1,
        processTerminator: new CurrentProcessTerminator(() => harness.hasExited),
      },
    );
    const startedAt = Date.now();

    await expect(controller.stop(harness.workspaceRoot)).resolves.toEqual({
      status: "killed",
      workspaceRoot: harness.workspaceRoot,
      pid: process.pid,
    });
    expect(harness.hasExited).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
    await harness.exited;
    expect(harness.registry.read(harness.identity)).toBeUndefined();
  });

  it("force-stops a real matching daemon process with a stuck request", async () => {
    const stateDirectory = canonicalStateDir(
      mkdtempSync(join(tmpdir(), "symnav-daemon-child-state-")),
    );
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symnav-daemon-child-workspace-"));
    mkdirSync(join(workspaceRoot, ".git"));
    writeFileSync(join(workspaceRoot, "input.ts"), "export const value = 1;\n");
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    const instanceId = "real-stuck-instance";
    const processToken = "real-stuck-token";
    const readyPath = join(stateDirectory, "daemon-ready");
    const requestStartedPath = join(stateDirectory, "request-started");
    const lease = registry.acquireStartup(identity, instanceId);
    expect(lease).toBeDefined();
    const child = spawnStuckDaemon(
      workspaceRoot,
      stateDirectory,
      instanceId,
      processToken,
      readyPath,
      requestStartedPath,
    );
    childProcesses.push(child);
    if (child.pid === undefined) throw new Error("Stuck daemon did not receive a PID");
    await waitUntil(() => existsSync(`${readyPath}.boot`));
    const daemonPid = Number(readFileSync(`${readyPath}.boot`, "utf8"));
    expect(
      registry.writeStartingIfStartupOwner(identity, {
        schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        symnavVersion: "test",
        workspaceRoot,
        workspaceKey: identity.workspaceKey,
        stateKey: identity.stateKey,
        identityKey: identity.identityKey,
        instanceId,
        processToken,
        endpoint: identity.endpoint(instanceId),
        pid: daemonPid,
        state: "starting",
        startedAt: Date.now(),
        memoryCapBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(true);
    await waitUntil(() => existsSync(readyPath));
    lease?.release();
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 200 });
    void transport
      .request(identity.endpoint(instanceId), {
        kind: "execute",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId,
        requestId: "stuck-child-request",
        request: { argv: ["--version"], cwd: workspaceRoot, telemetryEnabled: false },
      })
      .catch(() => undefined);
    await waitUntil(() => existsSync(requestStartedPath));
    const controller = new DaemonController(registry, transport, stateDirectory, {
      stopTimeoutMs: 500,
      pollIntervalMs: 1,
    });

    await expect(controller.stop(workspaceRoot)).resolves.toEqual({
      status: "killed",
      workspaceRoot,
      pid: daemonPid,
    });
    expect(() => process.kill(daemonPid, 0)).toThrow();
    await waitForProcess(child);
    childProcesses.splice(childProcesses.indexOf(child), 1);
    expect(registry.read(identity)).toBeUndefined();
    rmSync(stateDirectory, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }, 10_000);

  it("removes registry and transport state after idle shutdown and logs without terminal bytes", async () => {
    const harness = await WorkspaceDaemonHarness.start(new ImmediateExecutor(), {
      idleTimeoutMs: 10,
    });
    harnesses.push(harness);

    await harness.exited;

    expect(harness.registry.read(harness.identity)).toBeUndefined();
    await expect(harness.ping()).rejects.toThrow();
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "stop", reason: "idle" })]),
    );
    expect(readFileSync(harness.identity.logPath, "utf8")).not.toContain("\u001B");
  });

  it("retains ready ownership while transport shutdown is blocked", async () => {
    const transport = new BlockingCloseTransport();
    const harness = await WorkspaceDaemonHarness.start(new ImmediateExecutor(), { transport });
    harnesses.push(harness);

    const killing = transport.request(harness.identity.endpoint(harness.instanceId), {
      kind: "kill",
      instanceId: harness.instanceId,
      processToken: "runtime-token",
    });
    await transport.waitUntilCloseStarted();

    expect(harness.registry.read(harness.identity)).toMatchObject({
      instanceId: harness.instanceId,
      state: "ready",
    });
    expect(harness.hasExited).toBe(false);

    transport.allowClose();
    await killing;
    await harness.exited;
  });

  it("releases daemon-owned startup authorization after publishing readiness", async () => {
    const harness = await WorkspaceDaemonHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    expect(harness.registry.read(harness.identity)?.state).toBe("ready");
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
  });

  it("recovers from rejected work and exits after the recovered queue becomes idle", async () => {
    const harness = await WorkspaceDaemonHarness.start(new RejectThenSucceedExecutor(), {
      idleTimeoutMs: 30,
    });
    harnesses.push(harness);

    await expect(harness.execute("rejected")).rejects.toThrow();
    await expect(harness.execute("recovered")).resolves.toMatchObject({
      kind: "result",
      requestId: "recovered",
      result: { exitCode: 0 },
    });
    await harness.exited;

    expect(harness.registry.read(harness.identity)).toBeUndefined();
    expect(existsSync(harness.identity.endpoint(harness.instanceId))).toBe(false);
    await expect(harness.ping()).rejects.toThrow();
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "failure", operation: "request" }),
        expect.objectContaining({ kind: "request", exitCode: 0 }),
        expect.objectContaining({ kind: "stop", reason: "idle" }),
      ]),
    );
  });

  it("force-closes active work without terminal output when resident memory exceeds the cap", async () => {
    let resourceExceeded = false;
    const executor = new DeferredExecutor();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const harness = await WorkspaceDaemonHarness.start(executor, {
      memoryCapBytes: 1,
      resourceCheckIntervalMs: 5,
      residentMemoryBytes: () => (resourceExceeded ? 2 : 0),
    });
    harnesses.push(harness);
    const activeRequest = harness.execute("resource-active");
    await executor.started;
    const startedAt = Date.now();
    resourceExceeded = true;

    await harness.exited;

    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(activeRequest).rejects.toThrow();
    expect(harness.registry.read(harness.identity)).toBeUndefined();
    await expect(harness.execute("after-resource")).rejects.toThrow();
    await expect(harness.ping()).rejects.toThrow();
    expect(existsSync(harness.identity.endpoint(harness.instanceId))).toBe(false);
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "stop", reason: "resource" })]),
    );
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    stdout.mockRestore();
    stderr.mockRestore();
  });
});

interface RuntimeOptions {
  readonly idleTimeoutMs?: number;
  readonly memoryCapBytes?: number;
  readonly resourceCheckIntervalMs?: number;
  readonly residentMemoryBytes?: () => number;
  readonly transport?: LocalDaemonTransport;
}

class WorkspaceDaemonHarness {
  readonly stateDirectory: string;
  readonly workspaceRoot: string;
  readonly identity: DaemonWorkspaceIdentity;
  readonly registry: DaemonRegistry;
  readonly transport: LocalDaemonTransport;
  readonly instanceId = "runtime-instance";
  readonly exited: Promise<number>;
  private resolveExit!: (code: number) => void;
  private exitCode: number | undefined;

  get hasExited(): boolean {
    return this.exitCode !== undefined;
  }

  private constructor(transport = new LocalDaemonTransport({ requestTimeoutMs: 200 })) {
    this.transport = transport;
    this.stateDirectory = mkdtempSync(join(tmpdir(), "symnav-daemon-runtime-state-"));
    this.workspaceRoot = mkdtempSync(join(tmpdir(), "symnav-daemon-runtime-workspace-"));
    mkdirSync(join(this.workspaceRoot, ".git"));
    writeFileSync(join(this.workspaceRoot, "input.ts"), "export const value = 1;\n");
    this.identity = DaemonWorkspaceIdentity.from(this.workspaceRoot, this.stateDirectory);
    this.registry = new DaemonRegistry(this.identity.registryDirectory);
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  static async start(
    executor: DaemonCommandExecutor,
    runtime: RuntimeOptions = {},
  ): Promise<WorkspaceDaemonHarness> {
    const harness = new WorkspaceDaemonHarness(runtime.transport);
    const lease = harness.registry.acquireStartup(harness.identity, harness.instanceId);
    if (lease === undefined) throw new Error("Expected startup ownership");
    if (
      !harness.registry.writeStartingIfStartupOwner(harness.identity, {
        schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        symnavVersion: "test",
        workspaceRoot: harness.workspaceRoot,
        workspaceKey: harness.identity.workspaceKey,
        stateKey: harness.identity.stateKey,
        identityKey: harness.identity.identityKey,
        instanceId: harness.instanceId,
        processToken: "runtime-token",
        endpoint: harness.identity.endpoint(harness.instanceId),
        pid: process.pid,
        state: "starting",
        startedAt: Date.now(),
        memoryCapBytes: runtime.memoryCapBytes ?? 1024,
      })
    ) {
      throw new Error("Expected daemon-owned startup publication");
    }
    const daemon = new WorkspaceDaemon({
      identity: harness.identity,
      instanceId: harness.instanceId,
      processToken: "runtime-token",
      symnavVersion: "test",
      memoryCapBytes: runtime.memoryCapBytes ?? 1024,
      dependencies: createDefaultDependencies(harness.identity.stateDirectory),
      registry: harness.registry,
      transport: harness.transport,
      executor,
      exit: (code) => {
        harness.exitCode = code;
        harness.resolveExit(code);
      },
      ...runtime,
    });
    await daemon.start();
    return harness;
  }

  execute(requestId: string) {
    return this.transport.request(this.identity.endpoint(this.instanceId), {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      requestId,
      request: { argv: ["--version"], cwd: this.workspaceRoot, telemetryEnabled: false },
    });
  }

  stop() {
    return this.transport.request(this.identity.endpoint(this.instanceId), {
      kind: "stop",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
    });
  }

  ping() {
    return this.transport.request(this.identity.endpoint(this.instanceId), {
      kind: "ping",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
    });
  }

  logEvents(): readonly Record<string, unknown>[] {
    return readFileSync(this.identity.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  async dispose(): Promise<void> {
    if (this.exitCode === undefined) {
      await this.transport
        .request(this.identity.endpoint(this.instanceId), {
          kind: "kill",
          instanceId: this.instanceId,
          processToken: "runtime-token",
        })
        .catch(() => undefined);
      await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 250))]);
    }
    rmSync(this.stateDirectory, { recursive: true, force: true });
    rmSync(this.workspaceRoot, { recursive: true, force: true });
  }
}

class BlockingCloseTransport extends LocalDaemonTransport {
  private handler: ((request: DaemonRequest) => Promise<DaemonResponse>) | undefined;
  private readonly closeStarted: Promise<void>;
  private resolveCloseStarted!: () => void;
  private readonly closeAllowed: Promise<void>;
  private resolveCloseAllowed!: () => void;

  constructor() {
    super();
    this.closeStarted = new Promise((resolve) => {
      this.resolveCloseStarted = resolve;
    });
    this.closeAllowed = new Promise((resolve) => {
      this.resolveCloseAllowed = resolve;
    });
  }

  override async listen(
    _endpoint: string,
    handler: (request: DaemonRequest) => Promise<DaemonResponse>,
  ): Promise<DaemonServer> {
    this.handler = handler;
    return {
      close: async () => {
        this.resolveCloseStarted();
        await this.closeAllowed;
      },
    };
  }

  override request(_endpoint: string, request: DaemonRequest): Promise<DaemonResponse> {
    if (this.handler === undefined) throw new Error("Daemon transport is not listening");
    return this.handler(request);
  }

  waitUntilCloseStarted(): Promise<void> {
    return this.closeStarted;
  }

  allowClose(): void {
    this.resolveCloseAllowed();
  }
}

class DeferredExecutor implements DaemonCommandExecutor {
  readonly started: Promise<void>;
  private resolveStarted!: () => void;
  private resolveResult!: (result: CommandExecutionResult) => void;
  private readonly result: Promise<CommandExecutionResult>;

  constructor() {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  execute(_request: CliExecutionRequest): Promise<CommandExecutionResult> {
    this.resolveStarted();
    return this.result;
  }

  complete(result: CommandExecutionResult): void {
    this.resolveResult(result);
  }
}

class ImmediateExecutor implements DaemonCommandExecutor {
  async execute(_request: CliExecutionRequest): Promise<CommandExecutionResult> {
    return { frames: [], exitCode: 0 };
  }
}

class RejectThenSucceedExecutor implements DaemonCommandExecutor {
  private executionCount = 0;

  async execute(_request: CliExecutionRequest): Promise<CommandExecutionResult> {
    this.executionCount += 1;
    if (this.executionCount === 1) throw new Error("executor rejected");
    return { frames: [], exitCode: 0 };
  }
}

class CurrentProcessTerminator implements DaemonProcessTerminator {
  constructor(private readonly exited: () => boolean) {}

  isAlive(pid: number): boolean {
    return pid === process.pid && !this.exited();
  }

  terminate(): Promise<void> {
    throw new Error("Controller must not signal by PID");
  }
}

function spawnStuckDaemon(
  workspaceRoot: string,
  stateDirectory: string,
  instanceId: string,
  processToken: string,
  readyPath: string,
  requestStartedPath: string,
): ChildProcess {
  return spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
      fileURLToPath(new URL("../../test/helpers/workspace-daemon-stuck.ts", import.meta.url)),
      workspaceRoot,
      stateDirectory,
      instanceId,
      processToken,
      readyPath,
      requestStartedPath,
    ],
    { stdio: "ignore" },
  );
}

function waitForProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Stuck daemon exited with code ${String(code)}`));
    });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for daemon runtime state");
}
