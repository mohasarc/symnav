import { writeFileSync } from "node:fs";
import { DAEMON_PROTOCOL_VERSION } from "../../src/daemon/daemon-protocol.js";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "./local-daemon-transport.js";

const [endpoint, instanceId, processToken, workspaceRoot, acceptedPath] = process.argv.slice(2);
if (
  endpoint === undefined ||
  instanceId === undefined ||
  processToken === undefined ||
  workspaceRoot === undefined ||
  acceptedPath === undefined
) {
  process.exit(2);
}

const receipt = await new LocalDaemonTransport({ requestTimeoutMs: 5_000 }).execute(endpoint, {
  kind: "execute",
  protocolVersion: DAEMON_PROTOCOL_VERSION,
  instanceId,
  processToken,
  requestId: "accepted-disconnect",
  request: {
    argv: ["overview", "input.ts"],
    cwd: workspaceRoot,
    telemetryEnabled: true,
    executionMode: "warm",
  },
});
writeFileSync(acceptedPath, JSON.stringify(receipt.acceptance));
await receipt.completion;
