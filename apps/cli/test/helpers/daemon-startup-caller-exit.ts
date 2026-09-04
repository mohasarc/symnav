import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DaemonPolicy } from "@symnav/daemon";
import { createDefaultDependencies } from "../../src/program.js";
import { StateDirectoryResolver } from "../../src/state-directory-resolver.js";
import type {
  DaemonNavigationWorker,
  DaemonNavigationWorkerExit,
} from "../../src/daemon/daemon-navigation-worker.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "../../src/daemon/daemon-protocol.js";
import type { DaemonNavigationWorkerResponse } from "../../src/daemon/daemon-navigation-worker-protocol.js";
import { TestDaemonRegistry as DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../src/daemon/daemon-workspace-identity.js";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "./local-daemon-transport.js";
import { NodeDaemonNavigationWorker } from "../../src/daemon/daemon-navigation-worker.js";
import { TestWorkspaceDaemon as WorkspaceDaemon } from "./workspace-daemon.js";

class DaemonStartupCallerExit {
  static async run(argumentsAfterEntry: readonly string[]): Promise<void> {
    if (argumentsAfterEntry[0] === "--child") {
      await DaemonStartupCallerExit.runDaemon(argumentsAfterEntry.slice(1));
      return;
    }
    await DaemonStartupCallerExit.runCaller(argumentsAfterEntry);
  }

  private static async runCaller(argumentsAfterEntry: readonly string[]): Promise<void> {
    const [
      workspaceRoot,
      stateDirectory,
      instanceId,
      processToken,
      bootPath,
      readyPath,
      callerBarrierPath,
      childReleasePath,
    ] = argumentsAfterEntry;
    if (
      workspaceRoot === undefined ||
      stateDirectory === undefined ||
      instanceId === undefined ||
      processToken === undefined ||
      bootPath === undefined ||
      readyPath === undefined ||
      callerBarrierPath === undefined ||
      childReleasePath === undefined
    ) {
      process.exit(2);
    }
    const identity = DaemonWorkspaceIdentity.from(
      workspaceRoot,
      StateDirectoryResolver.canonicalize(stateDirectory),
    );
    const registry = new DaemonRegistry(identity.registryDirectory);
    if (
      registry.acquireStartup(identity, {
        identityKey: identity.identityKey,
        instanceId,
        processToken,
        ownerPid: process.pid,
        ownerKind: "launcher",
        heartbeatAt: Date.now(),
      }) === undefined
    ) {
      process.exit(3);
    }
    const daemonPolicy = DaemonPolicy.currentSystem();
    const dependencies = createDefaultDependencies(identity.stateDirectory, daemonPolicy);
    const startingRecord: DaemonRecord = {
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: dependencies.symnavVersion,
      workspaceRoot: identity.workspaceRoot,
      workspaceKey: identity.workspaceKey,
      stateKey: identity.stateKey,
      identityKey: identity.identityKey,
      instanceId,
      processToken,
      endpoint: identity.endpoint(instanceId),
      pid: 0,
      state: "starting",
      startedAt: Date.now(),
      memoryCapBytes: Number.MAX_SAFE_INTEGER,
    };
    if (!registry.writeStartingIfStartupOwner(identity, startingRecord)) process.exit(4);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
        fileURLToPath(import.meta.url),
        "--child",
        workspaceRoot,
        stateDirectory,
        instanceId,
        processToken,
        bootPath,
        readyPath,
        childReleasePath,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    await DaemonStartupCallerExit.waitUntil(() => existsSync(bootPath));
    writeFileSync(callerBarrierPath, "spawned");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }

  private static async runDaemon(argumentsAfterMode: readonly string[]): Promise<void> {
    const [
      workspaceRoot,
      stateDirectory,
      instanceId,
      processToken,
      bootPath,
      readyPath,
      releasePath,
    ] = argumentsAfterMode;
    if (
      workspaceRoot === undefined ||
      stateDirectory === undefined ||
      instanceId === undefined ||
      processToken === undefined ||
      bootPath === undefined ||
      readyPath === undefined ||
      releasePath === undefined
    ) {
      process.exit(2);
    }
    const identity = DaemonWorkspaceIdentity.from(
      workspaceRoot,
      StateDirectoryResolver.canonicalize(stateDirectory),
    );
    const daemonPolicy = DaemonPolicy.currentSystem();
    const dependencies = createDefaultDependencies(identity.stateDirectory, daemonPolicy);
    const navigationWorker = new StartupBarrierNavigationWorker(
      new NodeDaemonNavigationWorker({
        generation: 1,
        configuration: {
          stateDirectory: identity.stateDirectory,
          productVersion: dependencies.symnavVersion,
          executorModuleUrl: new URL("../../dist/daemon-executor.js", import.meta.url).href,
          policy: dependencies.daemonPolicy.toSerialized(),
        },
        resourceLimits: { maxOldGenerationSizeMb: 4096 },
        entryUrl: new URL("../../dist/daemon/daemon-navigation-worker-entry.js", import.meta.url),
      }),
      bootPath,
      releasePath,
    );
    await new WorkspaceDaemon({
      identity,
      instanceId,
      processToken,
      symnavVersion: dependencies.symnavVersion,
      memoryCapBytes: Number.MAX_SAFE_INTEGER,
      policy: daemonPolicy,
      dependencies,
      registry: new DaemonRegistry(identity.registryDirectory),
      transport: new LocalDaemonTransport(),
      navigationWorker,
      startupHeartbeatIntervalMs: 10,
    }).start();
    writeFileSync(readyPath, "ready");
  }

  static async waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() <= deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for detached daemon startup");
  }

  static async waitForRelease(releasePath: string): Promise<void> {
    while (!existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

class StartupBarrierNavigationWorker implements DaemonNavigationWorker {
  get generation(): number {
    return this.worker.generation;
  }

  get exited(): Promise<DaemonNavigationWorkerExit> {
    return this.worker.exited;
  }

  constructor(
    private readonly worker: DaemonNavigationWorker,
    private readonly bootPath: string,
    private readonly releasePath: string,
  ) {}

  async start(workspaceRoot: string): Promise<DaemonNavigationWorkerResponse> {
    writeFileSync(this.bootPath, String(process.pid));
    await DaemonStartupCallerExit.waitForRelease(this.releasePath);
    return this.worker.start(workspaceRoot);
  }

  execute(
    requestId: string,
    commandName: Parameters<DaemonNavigationWorker["execute"]>[1],
    request: Parameters<DaemonNavigationWorker["execute"]>[2],
    output: Parameters<DaemonNavigationWorker["execute"]>[3],
  ): Promise<DaemonNavigationWorkerResponse> {
    return this.worker.execute(requestId, commandName, request, output);
  }

  releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    return this.worker.releaseTransientResources();
  }

  drainAndClose(): Promise<void> {
    return this.worker.drainAndClose();
  }

  terminate(): Promise<void> {
    return this.worker.terminate();
  }
}

await DaemonStartupCallerExit.run(process.argv.slice(2));
