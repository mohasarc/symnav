import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CanonicalTestPath } from "./canonical-path.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
} from "../../src/transport/protocol.js";
import { TestDaemonRegistry as DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../src/registry/workspace-identity.js";

const [workspaceRoot, stateDirectory, startupDelayMsText] = process.argv.slice(2);
if (
  workspaceRoot === undefined ||
  stateDirectory === undefined ||
  startupDelayMsText === undefined
) {
  process.exit(2);
}

await new Promise<void>((resolve) => setTimeout(resolve, Number(startupDelayMsText)));

const identity = DaemonWorkspaceIdentity.from(
  workspaceRoot,
  CanonicalTestPath.resolve(stateDirectory),
);
const registry = new DaemonRegistry(identity.registryDirectory);
const instanceId = "orphaned-mutation";
const lease = registry.acquireStartup(identity, instanceId);
if (lease === undefined) process.exit(3);
if (
  !registry.writeStartingIfStartupOwner(identity, {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    workspaceRoot,
    workspaceKey: identity.workspaceKey,
    stateKey: identity.stateKey,
    identityKey: identity.identityKey,
    instanceId,
    processToken: "orphaned-mutation-token",
    endpoint: identity.endpoint(instanceId),
    pid: 0,
    state: "starting",
    startedAt: Date.now(),
    memoryCapBytes: 256 * 1024 * 1024,
  })
) {
  process.exit(4);
}

const token = randomUUID();
const claimPath = identity.startupMutationClaimPath(token);
mkdirSync(claimPath, { mode: 0o700 });
writeFileSync(
  identity.startupOwnerPath(claimPath),
  JSON.stringify({ ownerPid: process.pid, acquiredAt: Date.now(), token }),
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
renameSync(claimPath, identity.startupMutationPath);
if (process.send === undefined) process.exit(5);
process.send(process.pid, (error) => {
  if (error !== null) process.exit(5);
  process.disconnect?.();
});
setInterval(() => undefined, 1_000);
