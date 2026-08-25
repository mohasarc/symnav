import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalStateDir } from "@symnav/telemetry";
import { createDefaultDependencies } from "../../src/program.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "../../src/daemon/daemon-protocol.js";
import { DaemonRegistry } from "../../src/daemon/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../src/daemon/daemon-workspace-identity.js";
import { LocalDaemonTransport } from "../../src/daemon/local-daemon-transport.js";
import { NodeDaemonNavigationWorker } from "../../src/daemon/daemon-navigation-worker.js";
import { WorkspaceDaemon } from "../../src/daemon/workspace-daemon.js";

class DaemonStartupCallerExit {
  static async run(argumentsAfterEntry: readonly string[]): Promise<void> {
    if (argumentsAfterEntry[0] === "--child") {
      await DaemonStartupCallerExit.runDaemon(argumentsAfterEntry.slice(1));
      return;
    }
    await DaemonStartupCallerExit.runCaller(argumentsAfterEntry);
  }

  private static async runCaller(argumentsAfterEntry: readonly string[]): Promise<void> {
    const [workspaceRoot, stateDirectory, instanceId, processToken, bootPath, readyPath] =
      argumentsAfterEntry;
    if (
      workspaceRoot === undefined ||
      stateDirectory === undefined ||
      instanceId === undefined ||
      processToken === undefined ||
      bootPath === undefined ||
      readyPath === undefined
    ) {
      process.exit(2);
    }
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, canonicalStateDir(stateDirectory));
    const registry = new DaemonRegistry(identity.registryDirectory);
    if (registry.acquireStartup(identity, instanceId) === undefined) process.exit(3);
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
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    await DaemonStartupCallerExit.waitUntil(() => existsSync(bootPath));
    const daemonPid = Number(readFileSync(bootPath, "utf8"));
    const dependencies = createDefaultDependencies(identity.stateDirectory);
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
      pid: daemonPid,
      state: "starting",
      startedAt: Date.now(),
      memoryCapBytes: Number.MAX_SAFE_INTEGER,
    };
    if (!registry.writeStartingIfStartupOwner(identity, startingRecord)) process.exit(4);
  }

  private static async runDaemon(argumentsAfterMode: readonly string[]): Promise<void> {
    const [workspaceRoot, stateDirectory, instanceId, processToken, bootPath, readyPath] =
      argumentsAfterMode;
    if (
      workspaceRoot === undefined ||
      stateDirectory === undefined ||
      instanceId === undefined ||
      processToken === undefined ||
      bootPath === undefined ||
      readyPath === undefined
    ) {
      process.exit(2);
    }
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, canonicalStateDir(stateDirectory));
    writeFileSync(bootPath, String(process.pid));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const dependencies = createDefaultDependencies(identity.stateDirectory);
    await new WorkspaceDaemon({
      identity,
      instanceId,
      processToken,
      symnavVersion: dependencies.symnavVersion,
      memoryCapBytes: Number.MAX_SAFE_INTEGER,
      dependencies,
      registry: new DaemonRegistry(identity.registryDirectory),
      transport: new LocalDaemonTransport(),
      navigationWorker: new NodeDaemonNavigationWorker({
        generation: 1,
        stateDirectory: identity.stateDirectory,
        entryUrl: new URL("../../dist/daemon/daemon-navigation-worker-entry.js", import.meta.url),
      }),
    }).start();
    writeFileSync(readyPath, "ready");
  }

  private static async waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() <= deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for detached daemon startup");
  }
}

await DaemonStartupCallerExit.run(process.argv.slice(2));
