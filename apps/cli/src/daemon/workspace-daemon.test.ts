import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import { createDefaultDependencies } from "../program.js";
import { DAEMON_PROTOCOL_VERSION } from "./daemon-protocol.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";
import { type DaemonCommandExecutor, WorkspaceDaemon } from "./workspace-daemon.js";

describe("WorkspaceDaemon runtime lifecycle", () => {
  const harnesses: WorkspaceDaemonHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.map((harness) => harness.dispose()));
    harnesses.length = 0;
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
});

class WorkspaceDaemonHarness {
  readonly stateDirectory: string;
  readonly workspaceRoot: string;
  readonly identity: DaemonWorkspaceIdentity;
  readonly registry: DaemonRegistry;
  readonly transport = new LocalDaemonTransport({ requestTimeoutMs: 200 });
  readonly instanceId = "runtime-instance";
  readonly exited: Promise<number>;
  private resolveExit!: (code: number) => void;
  private exitCode: number | undefined;

  private constructor() {
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

  static async start(executor: DaemonCommandExecutor): Promise<WorkspaceDaemonHarness> {
    const harness = new WorkspaceDaemonHarness();
    const lease = harness.registry.acquireStartup(harness.identity, harness.instanceId);
    if (lease === undefined) throw new Error("Expected startup ownership");
    harness.registry.write({
      schemaVersion: 1,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: "test",
      workspaceRoot: harness.workspaceRoot,
      workspaceKey: harness.identity.workspaceKey,
      instanceId: harness.instanceId,
      processToken: "runtime-token",
      endpoint: harness.identity.endpoint(harness.instanceId),
      pid: process.pid,
      state: "starting",
      startedAt: Date.now(),
      memoryCapBytes: 1024,
    });
    const daemon = new WorkspaceDaemon({
      identity: harness.identity,
      instanceId: harness.instanceId,
      processToken: "runtime-token",
      symnavVersion: "test",
      memoryCapBytes: 1024,
      dependencies: createDefaultDependencies(),
      registry: harness.registry,
      transport: harness.transport,
      executor,
      exit: ((code: number) => {
        harness.exitCode = code;
        harness.resolveExit(code);
      }) as (code: number) => never,
    });
    await daemon.start();
    lease.release();
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

  async dispose(): Promise<void> {
    if (this.exitCode === undefined) {
      await this.stop().catch(() => undefined);
      await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 250))]);
    }
    rmSync(this.stateDirectory, { recursive: true, force: true });
    rmSync(this.workspaceRoot, { recursive: true, force: true });
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
