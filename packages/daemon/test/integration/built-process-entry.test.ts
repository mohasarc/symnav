import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DaemonController } from "../../dist/process/controller.js";
import { PosixDaemonProcessLifetime } from "../../dist/process/posix-process-lifetime.js";
import { DaemonTransportFactory } from "../../dist/transport/daemon-transport.js";
import { DaemonPolicy } from "../../dist/daemon-policy.js";
import {
  type DaemonProcess,
  type DaemonProcessExit,
  NodeDaemonProcessLauncher,
} from "../../dist/process/process-launcher.js";
import { DaemonRegistry } from "../../dist/registry/registry.js";
import { DaemonWorkspaceIdentity } from "../../dist/registry/workspace-identity.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "../../dist/transport/protocol.js";
import { DaemonPolicyTestFactory } from "../helpers/daemon-policy.js";

interface ExecutorCreationEvent {
  readonly kind: "create";
  readonly stateDirectory: string;
  readonly productVersion: string;
}

interface ExecutorInitializationEvent {
  readonly kind: "initialize";
  readonly workspaceRoot: string;
}

type ExecutorEvent = ExecutorCreationEvent | ExecutorInitializationEvent;

class BuiltProcessEntryHarness {
  readonly root = mkdtempSync(join(tmpdir(), "symnav-built-process-entry-"));
  readonly stateDirectory = join(this.root, "state");
  readonly workspaceRoot = join(this.root, "workspace");
  readonly identity = DaemonWorkspaceIdentity.from(this.workspaceRoot, this.stateDirectory);
  readonly instanceId = "built-process-entry";
  readonly processToken = "built-process-entry-token";
  readonly productVersion = "built-process-entry-version";
  readonly startedAt = Date.now();
  readonly eventPath = join(this.stateDirectory, "executor-events.jsonl");
  readonly policy = DaemonPolicyTestFactory.withOverrides(
    DaemonPolicy.fromSystemMemory({ totalBytes: 512 * 1024 * 1024 }),
    {
      startup: {
        coordinationGraceMs: 2_000,
        heartbeatIntervalMs: 20,
        authorizationPollIntervalMs: 5,
      },
      shutdown: {
        processSignalExitTimeoutMs: 1_000,
        processExitPollIntervalMs: 5,
      },
    },
  );
  readonly registry = new DaemonRegistry(
    this.identity.registryDirectory,
    this.policy.values.startup,
  );
  private daemonProcess: DaemonProcess | undefined;
  private observedExit: DaemonProcessExit | undefined;

  constructor(readonly executorModuleUrl: string) {
    mkdirSync(this.workspaceRoot, { recursive: true });
    mkdirSync(this.stateDirectory, { recursive: true });
  }

  async launch(): Promise<void> {
    const lease = this.registry.acquireStartup(this.identity, {
      identityKey: this.identity.identityKey,
      instanceId: this.instanceId,
      processToken: this.processToken,
      ownerPid: process.pid,
      ownerKind: "launcher",
      heartbeatAt: Date.now(),
    });
    if (lease === undefined) throw new Error("Built process entry startup lease unavailable");
    const startingRecord = this.startingRecord(0);
    if (!this.registry.writeStartingIfStartupOwner(this.identity, startingRecord)) {
      throw new Error("Built process entry starting record unavailable");
    }
    const daemonProcess = await new NodeDaemonProcessLauncher(
      this.productVersion,
      this.executorModuleUrl,
      this.policy,
    ).launch(this.identity, this.instanceId, this.processToken);
    this.daemonProcess = daemonProcess;
    void daemonProcess.exited.then((exit) => {
      this.observedExit = exit;
    });
    const transferred = lease.transferToDaemon(
      daemonProcess.pid,
      this.processToken,
      daemonProcess.processLifetime,
    );
    if (
      !transferred &&
      !this.registry.daemonOwnsStartupProcess(
        this.identity,
        this.instanceId,
        this.processToken,
        daemonProcess.pid,
      )
    ) {
      throw new Error("Built process entry startup ownership unavailable");
    }
    if (
      !this.registry.writeStartingIfStartupOwner(
        this.identity,
        this.startingRecord(daemonProcess.pid),
      )
    ) {
      throw new Error("Built process entry process record unavailable");
    }
  }

  async stop(): Promise<unknown> {
    const components = DaemonTransportFactory.create({ policy: this.policy });
    const controller = new DaemonController(
      this.registry,
      {
        request: components.lifecycle.request.bind(components.lifecycle),
        execute: components.execution.execute.bind(components.execution),
      },
      this.stateDirectory,
      { policy: this.policy.values },
    );
    return controller.stop(this.workspaceRoot);
  }

  async waitForBootstrap(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (existsSync(join(this.stateDirectory, "bootstrap-waiting"))) return;
      await delay(5);
    }
    throw new Error("Built entry did not reach delayed bootstrap");
  }

  async waitForReady(): Promise<DaemonRecord> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const record = this.registry.readInstance(this.identity, this.instanceId);
      if (record?.state === "ready") return record;
      if (this.observedExit !== undefined) {
        throw new Error(
          `Built process entry exited before readiness: ${JSON.stringify({ exit: this.observedExit, events: this.events(), diagnostics: this.diagnostics() })}`,
        );
      }
      await delay(5);
    }
    throw new Error("Built process entry did not publish readiness");
  }

  async waitForExit(): Promise<DaemonProcessExit> {
    const daemonProcess = this.daemonProcess;
    if (daemonProcess === undefined) throw new Error("Built process entry was not launched");
    return Promise.race([
      daemonProcess.exited,
      delay(5_000).then(() => {
        throw new Error("Built process entry did not exit");
      }),
    ]);
  }

  events(): readonly ExecutorEvent[] {
    if (!existsSync(this.eventPath)) return [];
    return readFileSync(this.eventPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ExecutorEvent);
  }

  diagnosticKinds(): readonly string[] {
    if (!existsSync(this.identity.logPath)) return [];
    return readFileSync(this.identity.logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { readonly kind: string })
      .map((event) => event.kind);
  }

  diagnostics(): readonly unknown[] {
    if (!existsSync(this.identity.logPath)) return [];
    return readFileSync(this.identity.logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
  }

  startupArtifacts(): { readonly record: DaemonRecord | undefined; readonly owner: unknown } {
    return {
      record: this.registry.readInstance(this.identity, this.instanceId),
      owner: this.registry.startupOwner(this.identity),
    };
  }

  removeExitedProcess(record: DaemonRecord): boolean {
    return this.registry.removeIfProcess(this.identity, record.instanceId, record.processToken);
  }

  async terminate(): Promise<DaemonProcessExit | undefined> {
    if (this.daemonProcess === undefined) return undefined;
    await this.daemonProcess.terminate();
    return this.waitForExit();
  }

  async dispose(): Promise<void> {
    await this.terminate();
    rmSync(this.root, { recursive: true, force: true });
  }

  private startingRecord(pid: number): DaemonRecord {
    return {
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: this.productVersion,
      workspaceRoot: this.identity.workspaceRoot,
      workspaceKey: this.identity.workspaceKey,
      stateKey: this.identity.stateKey,
      identityKey: this.identity.identityKey,
      instanceId: this.instanceId,
      processToken: this.processToken,
      endpoint: this.identity.endpoint(this.instanceId),
      pid,
      ...(this.daemonProcess?.processLifetime === undefined
        ? {}
        : { processLifetime: this.daemonProcess.processLifetime }),
      state: "starting",
      startedAt: this.startedAt,
      memoryCapBytes: this.policy.values.resources.hardProcessRssBytes,
    };
  }
}

describe("built daemon process entry", () => {
  const packageDirectory = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const observableExecutorModuleUrl = pathToFileURL(
    join(packageDirectory, "test", "fixtures", "observable-executor-module.mjs"),
  ).href;

  it("executes its parsed generic executor configuration exactly once", async () => {
    const harness = new BuiltProcessEntryHarness(observableExecutorModuleUrl);
    try {
      await harness.launch();
      const ready = await harness.waitForReady();
      await delay(1_000);

      expect(ready).toMatchObject({
        state: "ready",
        workspaceRoot: harness.workspaceRoot,
        symnavVersion: harness.productVersion,
        instanceId: harness.instanceId,
        processToken: harness.processToken,
        fileCount: 1,
      });
      expect(harness.events()).toEqual([
        {
          kind: "create",
          stateDirectory: harness.stateDirectory,
          productVersion: harness.productVersion,
        },
        { kind: "initialize", workspaceRoot: harness.workspaceRoot },
      ]);
      expect(harness.diagnosticKinds().filter((kind) => kind === "start")).toEqual(["start"]);
      expect(harness.diagnosticKinds().filter((kind) => kind === "startup-completed")).toEqual([
        "startup-completed",
      ]);
      expect(harness.diagnosticKinds().filter((kind) => kind === "ready")).toEqual(["ready"]);
      await expect(harness.terminate()).resolves.toEqual(
        process.platform === "win32"
          ? { cause: "exit", code: null, signal: "SIGTERM" }
          : { cause: "exit", code: 1, signal: null },
      );
      const processTerminationDiagnostics = harness
        .diagnosticKinds()
        .filter((kind) => kind === "process-termination");
      if (process.platform === "win32") {
        expect(harness.startupArtifacts()).toEqual({ record: ready, owner: undefined });
        expect(processTerminationDiagnostics).toEqual([]);
        expect(harness.removeExitedProcess(ready)).toBe(true);
      } else {
        expect(harness.startupArtifacts()).toEqual({ record: undefined, owner: undefined });
        expect(processTerminationDiagnostics).toEqual(["process-termination"]);
      }
      expect(harness.startupArtifacts()).toEqual({ record: undefined, owner: undefined });
    } finally {
      await harness.dispose();
    }
  }, 10_000);

  it.skipIf(process.platform === "win32")(
    "authenticates a delayed pre-listen bootstrap within the existing stop deadline",
    async () => {
      const harness = new BuiltProcessEntryHarness(observableExecutorModuleUrl);
      const preload = pathToFileURL(
        join(packageDirectory, "test", "fixtures", "delayed-process-bootstrap.mjs"),
      ).href;
      try {
        vi.stubEnv("NODE_OPTIONS", `--import=${preload}`);
        await harness.launch();
        vi.unstubAllEnvs();
        await harness.waitForBootstrap();
        let settled = false;
        const stopping = harness.stop().finally(() => {
          settled = true;
        });
        await delay(20);
        expect(settled).toBe(false);
        expect(harness.startupArtifacts().record).toMatchObject({ state: "starting" });
        writeFileSync(join(harness.stateDirectory, "bootstrap-release"), "released");
        await expect(stopping).resolves.toMatchObject({ status: "stopped" });
        await expect(harness.waitForExit()).resolves.toMatchObject({ code: 0, cause: "exit" });
        expect(harness.startupArtifacts()).toEqual({ record: undefined, owner: undefined });
      } finally {
        vi.unstubAllEnvs();
        await harness.dispose();
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "retains a live pre-listen bootstrap after the existing stop deadline",
    async () => {
      const harness = new BuiltProcessEntryHarness(observableExecutorModuleUrl);
      const preload = pathToFileURL(
        join(packageDirectory, "test", "fixtures", "delayed-process-bootstrap.mjs"),
      ).href;
      try {
        vi.stubEnv("NODE_OPTIONS", `--import=${preload}`);
        await harness.launch();
        vi.unstubAllEnvs();
        await harness.waitForBootstrap();
        const ownership = harness.startupArtifacts();
        const lifetime = ownership.record!.processLifetime!;
        expect(PosixDaemonProcessLifetime.observe(lifetime)).toBe("live");
        const stopStartedAt = Date.now();

        await expect(harness.stop()).rejects.toThrow("live but unresponsive");

        expect(Date.now() - stopStartedAt).toBeGreaterThanOrEqual(
          harness.policy.values.shutdown.stopTimeoutMs,
        );
        expect(harness.startupArtifacts()).toEqual(ownership);
        expect(PosixDaemonProcessLifetime.observe(lifetime)).toBe("live");
        expect(harness.events()).toEqual([]);
        writeFileSync(join(harness.stateDirectory, "bootstrap-release"), "released");
        await expect(harness.stop()).resolves.toMatchObject({ status: "stopped" });
        await harness.waitForExit();
        expect(PosixDaemonProcessLifetime.observe(lifetime)).toBe("exited");
        expect(harness.startupArtifacts()).toEqual({ record: undefined, owner: undefined });
      } finally {
        vi.unstubAllEnvs();
        await harness.dispose();
      }
    },
    15_000,
  );

  it.each([
    [
      "missing module",
      pathToFileURL(join(packageDirectory, "test", "fixtures", "missing.mjs")).href,
    ],
    ["missing export", pathToFileURL(join(packageDirectory, "package.json")).href],
  ])(
    "retains %s startup failure and exact ownership cleanup",
    async (_scenario, moduleUrl) => {
      const harness = new BuiltProcessEntryHarness(moduleUrl);
      try {
        await harness.launch();

        await expect(harness.waitForExit()).resolves.toMatchObject({ cause: "exit", code: 1 });
        expect(harness.startupArtifacts()).toEqual({ record: undefined, owner: undefined });
      } finally {
        await harness.dispose();
      }
    },
    10_000,
  );
});
