import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DaemonWorkspaceIdentity } from "../../src/registry/workspace-identity.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "../../src/transport/protocol.js";
import type { StartupOwner } from "../../src/registry/registry.js";
import { PosixDaemonProcessLifetime } from "../../src/process/posix-process-lifetime.js";

class LegacyStartupActor {
  public static run(): void {
    const [workspace, stateDirectory, fixtureIntent] = process.argv.slice(2);
    if (
      workspace === undefined ||
      stateDirectory === undefined ||
      !["pid-only", "exited-owner"].includes(fixtureIntent ?? "")
    )
      throw new Error("Missing explicit legacy fixture intent");
    const identity = DaemonWorkspaceIdentity.from(workspace, stateDirectory);
    const instanceId = "intentional-legacy-startup";
    const processToken = "intentional-legacy-token";
    const lifetime =
      fixtureIntent === "exited-owner"
        ? PosixDaemonProcessLifetime.prepareChild(stateDirectory)
        : undefined;
    lifetime?.closeParentCopy();
    const owner: StartupOwner = {
      identityKey: identity.identityKey,
      instanceId,
      processToken,
      ownerKind: "daemon",
      ownerPid: process.pid,
      acquiredAt: 10,
      heartbeatAt: 10,
      revision: "intentional-legacy",
      ...(lifetime === undefined ? {} : { ownerLifetime: lifetime.identity }),
    };
    const record: DaemonRecord = {
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: "intentional-legacy",
      workspaceRoot: workspace,
      workspaceKey: identity.workspaceKey,
      stateKey: identity.stateKey,
      identityKey: identity.identityKey,
      instanceId,
      processToken,
      endpoint: identity.endpoint(instanceId),
      pid: process.pid,
      state: "starting",
      startedAt: 10,
      memoryCapBytes: 1024,
    };
    mkdirSync(identity.lockPath, { recursive: true });
    const paths = [identity.startupOwnerPath(identity.lockPath), identity.recordPath(instanceId)];
    writeFileSync(paths[0]!, JSON.stringify(owner));
    writeFileSync(paths[1]!, JSON.stringify(record));
    const snapshot = paths.map((path) => readFileSync(path, "utf8"));
    process.on("message", (message) => {
      if (message === "verify")
        process.send?.({
          kind: "verified",
          unchanged: paths.every((path, index) => readFileSync(path, "utf8") === snapshot[index]),
        });
    });
    process.send?.({ kind: "seeded" });
  }
}

LegacyStartupActor.run();
