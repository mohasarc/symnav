import { existsSync, writeFileSync } from "node:fs";
import { DaemonRegistry } from "../../src/daemon/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../src/daemon/daemon-workspace-identity.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "../../src/daemon/daemon-protocol.js";

const [workspaceRoot, stateDirectory, readyPath, barrierPath, resultPath] = process.argv.slice(2);
if (
  workspaceRoot === undefined ||
  stateDirectory === undefined ||
  readyPath === undefined ||
  barrierPath === undefined ||
  resultPath === undefined
) {
  process.exit(2);
}

const identity = DaemonWorkspaceIdentity.from(workspaceRoot, stateDirectory);
const registry = new DaemonRegistry(identity.registryDirectory);
const instanceId = "cross-process-startup";
const lease = registry.acquireStartup(identity, instanceId);
if (lease === undefined) process.exit(3);
const startingRecord: DaemonRecord = {
  schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
  protocolVersion: DAEMON_PROTOCOL_VERSION,
  symnavVersion: "test",
  workspaceRoot,
  workspaceKey: identity.workspaceKey,
  instanceId,
  processToken: "cross-process-token",
  endpoint: identity.endpoint(instanceId),
  pid: 0,
  state: "starting",
  startedAt: Date.now(),
  memoryCapBytes: 1024,
};
if (!registry.writeStartingIfStartupOwner(identity, startingRecord)) process.exit(4);
writeFileSync(readyPath, String(process.pid));

const timer = setInterval(() => {
  if (!existsSync(barrierPath)) return;
  clearInterval(timer);
  const startingPublished = registry.writeStartingIfStartupOwner(identity, {
    ...startingRecord,
    pid: process.pid,
  });
  const readyPublished = registry.writeIfStartupOwner(identity, {
    ...startingRecord,
    pid: process.pid,
    state: "ready",
    readyAt: Date.now(),
    fileCount: 1,
  });
  writeFileSync(resultPath, JSON.stringify({ startingPublished, readyPublished }));
  lease.release();
}, 5);
