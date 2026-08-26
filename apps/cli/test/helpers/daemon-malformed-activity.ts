import { writeFileSync } from "node:fs";
import type { DaemonResponse } from "../../src/daemon/daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION } from "../../src/daemon/daemon-protocol.js";
import { LocalDaemonTransport } from "../../src/daemon/local-daemon-transport.js";

const [endpoint, instanceId, processToken, startedAtValue, readyPath, secret] =
  process.argv.slice(2);
if (
  endpoint === undefined ||
  instanceId === undefined ||
  processToken === undefined ||
  startedAtValue === undefined ||
  readyPath === undefined ||
  secret === undefined
) {
  throw new Error("Missing malformed activity daemon arguments");
}
const startedAt = Number(startedAtValue);
const transport = new LocalDaemonTransport();
await transport.listen(endpoint, async (request) => {
  if (request.kind === "identify") {
    return { kind: "identity", instanceId, processToken, pid: process.pid, startedAt };
  }
  if (request.kind === "ping") {
    return {
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId,
      symnavVersion: "0.1.0",
      startedAt,
      activity: {
        lifecycle: "busy",
        pid: process.pid,
        startedAt,
        startupElapsedMs: 5_000,
        fileCount: 1,
        processRssBytes: 1,
        hardProcessRssBytes: 2,
        workerGeneration: 1,
        current: { requestId: "request", command: secret, elapsedMs: 10 },
        queued: 0,
        spoolBytes: 0,
      },
    } as unknown as DaemonResponse;
  }
  throw new Error("Malformed activity daemon supports identity and ping only");
});
writeFileSync(readyPath, String(process.pid));
