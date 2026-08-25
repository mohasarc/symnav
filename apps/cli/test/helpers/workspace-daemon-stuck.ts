import { existsSync, writeFileSync } from "node:fs";
import { canonicalStateDir } from "@symnav/telemetry";
import type {
  CliExecutionRequest,
  CommandExecutionResult,
} from "../../src/command-execution-result.js";
import { createDefaultDependencies } from "../../src/program.js";
import { CliProgramExecutor } from "../../src/cli-program-executor.js";
import { DaemonRegistry } from "../../src/daemon/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../src/daemon/daemon-workspace-identity.js";
import { LocalDaemonTransport } from "../../src/daemon/local-daemon-transport.js";
import { type DaemonCommandExecutor, WorkspaceDaemon } from "../../src/daemon/workspace-daemon.js";

const [
  workspaceRoot,
  stateDirectory,
  instanceId,
  processToken,
  readyPath,
  requestStartedPath,
  releasePathArgument,
  configuredSymnavVersion,
] = process.argv.slice(2);
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
const acceptedRequestStartedPath = requestStartedPath;
const oversizedResponse = releasePathArgument === "--oversized-response";
const releasePath =
  releasePathArgument === "--no-release" || oversizedResponse ? undefined : releasePathArgument;
const symnavVersion = configuredSymnavVersion ?? "test";
const dependencies = createDefaultDependencies();
const retainedBackends = dependencies.backends();
const executor = new CliProgramExecutor({ ...dependencies, backends: () => retainedBackends });
let executionCount = 0;

class ControlledExecutor implements DaemonCommandExecutor {
  async execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    executionCount += 1;
    writeFileSync(acceptedRequestStartedPath, "started");
    writeFileSync(`${acceptedRequestStartedPath}.${executionCount}`, "started");
    if (oversizedResponse) {
      const result = await executor.execute(request);
      return {
        ...result,
        frames: [
          ...result.frames,
          {
            stream: "stdout",
            bytesBase64: Buffer.alloc(9 * 1024 * 1024).toString("base64"),
          },
        ],
      };
    }
    if (releasePath === undefined) return new Promise(() => undefined);
    while (!existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return executor.execute(request);
  }
}

const identity = DaemonWorkspaceIdentity.from(workspaceRoot, canonicalStateDir(stateDirectory));
writeFileSync(`${readyPath}.boot`, String(process.pid));
const daemon = new WorkspaceDaemon({
  identity,
  instanceId,
  processToken,
  symnavVersion,
  memoryCapBytes: Number.MAX_SAFE_INTEGER,
  dependencies,
  registry: new DaemonRegistry(identity.registryDirectory),
  transport: new LocalDaemonTransport(),
  executor: new ControlledExecutor(),
});
await daemon.start();
writeFileSync(readyPath, "ready");
