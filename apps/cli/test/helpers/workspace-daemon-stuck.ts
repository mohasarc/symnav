import { writeFileSync } from "node:fs";
import type {
  CliExecutionRequest,
  CommandExecutionResult,
} from "../../src/command-execution-result.js";
import { createDefaultDependencies } from "../../src/program.js";
import { DaemonRegistry } from "../../src/daemon/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../src/daemon/daemon-workspace-identity.js";
import { LocalDaemonTransport } from "../../src/daemon/local-daemon-transport.js";
import { type DaemonCommandExecutor, WorkspaceDaemon } from "../../src/daemon/workspace-daemon.js";

const [workspaceRoot, stateDirectory, instanceId, processToken, readyPath, requestStartedPath] =
  process.argv.slice(2);
if (
  workspaceRoot === undefined ||
  stateDirectory === undefined ||
  instanceId === undefined ||
  processToken === undefined ||
  readyPath === undefined ||
  requestStartedPath === undefined
) {
  process.exit(2);
}

class StuckExecutor implements DaemonCommandExecutor {
  execute(_request: CliExecutionRequest): Promise<CommandExecutionResult> {
    writeFileSync(requestStartedPath, "started");
    return new Promise(() => undefined);
  }
}

const identity = DaemonWorkspaceIdentity.from(workspaceRoot, stateDirectory);
writeFileSync(`${readyPath}.boot`, String(process.pid));
const daemon = new WorkspaceDaemon({
  identity,
  instanceId,
  processToken,
  symnavVersion: "test",
  memoryCapBytes: Number.MAX_SAFE_INTEGER,
  dependencies: createDefaultDependencies(),
  registry: new DaemonRegistry(identity.registryDirectory),
  transport: new LocalDaemonTransport(),
  executor: new StuckExecutor(),
});
await daemon.start();
writeFileSync(readyPath, "ready");
