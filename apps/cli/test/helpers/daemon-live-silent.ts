import { writeFileSync } from "node:fs";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "./local-daemon-transport.js";

const [endpoint, instanceId, processToken, startedAtValue, readyPath] = process.argv.slice(2);
if (
  endpoint === undefined ||
  instanceId === undefined ||
  processToken === undefined ||
  startedAtValue === undefined ||
  readyPath === undefined
) {
  throw new Error("Missing live silent daemon arguments");
}
const startedAt = Number(startedAtValue);
const transport = new LocalDaemonTransport();
await transport.listen(endpoint, async (request) => {
  if (request.kind === "identify") {
    return { kind: "identity", instanceId, processToken, pid: process.pid, startedAt };
  }
  if (request.kind === "ping") return new Promise(() => undefined);
  throw new Error("Live silent daemon supports identity and ping only");
});
writeFileSync(readyPath, String(process.pid));
