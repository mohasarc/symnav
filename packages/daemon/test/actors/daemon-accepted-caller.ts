import { readFileSync, writeFileSync } from "node:fs";
import { DAEMON_PROTOCOL_VERSION } from "../../src/transport/protocol.js";
import { TestDaemonTransport as DaemonTransport } from "../helpers/daemon-transport.js";
import { DaemonWorkspaceIdentity } from "../../src/registry/workspace-identity.js";
import { TestDaemonRegistry as DaemonRegistry } from "../helpers/daemon-registry.js";
import type { DaemonExecutorRequest } from "../../src/daemon-executor.js";
import { CanonicalTestPath } from "../helpers/canonical-path.js";

const [stateDirectory, workspaceRoot, acceptedPath, mode, requestPath, requestIdPath] =
  process.argv.slice(2);
if (stateDirectory === undefined || workspaceRoot === undefined || acceptedPath === undefined) {
  process.exit(2);
}
const identity = DaemonWorkspaceIdentity.from(
  CanonicalTestPath.resolve(workspaceRoot),
  CanonicalTestPath.resolve(stateDirectory),
);
const record = new DaemonRegistry(identity.registryDirectory).read(identity);
if (record?.state !== "ready") throw new Error("Expected ready daemon record");
const duplicate = mode === "duplicate";
if (duplicate && (requestPath === undefined || requestIdPath === undefined)) process.exit(2);
const request = duplicate
  ? (JSON.parse(readFileSync(requestPath!, "utf8")) as DaemonExecutorRequest)
  : {
      argv: ["overview", "input.ts"],
      cwd: identity.workspaceRoot,
      telemetryEnabled: true,
      executionMode: "warm" as const,
    };

const receipt = await new DaemonTransport({ requestTimeoutMs: 5_000 }).execute(record.endpoint, {
  kind: "execute",
  protocolVersion: DAEMON_PROTOCOL_VERSION,
  instanceId: record.instanceId,
  processToken: record.processToken,
  requestId: duplicate ? readFileSync(requestIdPath!, "utf8") : "accepted-disconnect",
  commandName: duplicate ? "overview" : "version",
  request,
});
writeFileSync(acceptedPath, JSON.stringify(receipt.acceptance));
const completion = await receipt.completion;
writeFileSync(`${acceptedPath}.completion`, JSON.stringify(completion));
