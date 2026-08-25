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
import type {
  DaemonNavigationWorker,
  DaemonNavigationWorkerExit,
} from "../../src/daemon/daemon-navigation-worker.js";
import { NodeDaemonNavigationWorker } from "../../src/daemon/daemon-navigation-worker.js";
import type { DaemonNavigationWorkerResponse } from "../../src/daemon/daemon-navigation-worker-protocol.js";
import { WorkspaceDaemon } from "../../src/daemon/workspace-daemon.js";

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
const canonicalStateDirectory = canonicalStateDir(stateDirectory);
const dependencies = createDefaultDependencies(canonicalStateDirectory);
const retainedBackends = dependencies.backends();
const executor = new CliProgramExecutor({ ...dependencies, backends: () => retainedBackends });
let executionCount = 0;

class ControlledExecutor {
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

class ControlledNavigationWorker implements DaemonNavigationWorker {
  readonly generation = 1;
  readonly exited = new Promise<DaemonNavigationWorkerExit>(() => undefined);
  private readonly controlledExecutor = new ControlledExecutor();
  private rejectTermination!: (error: Error) => void;
  private readonly termination = new Promise<never>((_resolve, reject) => {
    this.rejectTermination = reject;
  });

  constructor() {
    void this.termination.catch(() => undefined);
  }

  async start(): Promise<DaemonNavigationWorkerResponse> {
    return {
      kind: "ready",
      generation: this.generation,
      fileCount: 1,
      refresh: { added: 1, changed: 0, removed: 0, unchanged: 0 },
      startupDurations: { discoveryMs: 0, indexingMs: 1, totalMs: 1 },
    };
  }

  async execute(
    requestId: string,
    request: CliExecutionRequest,
  ): Promise<DaemonNavigationWorkerResponse> {
    return {
      kind: "result",
      generation: this.generation,
      requestId,
      result: await Promise.race([this.controlledExecutor.execute(request), this.termination]),
      refresh: { added: 0, changed: 0, removed: 0, unchanged: 1 },
      durations: { freshnessMs: 0, navigationMs: 1, renderMs: 0, outputMs: 0 },
    };
  }

  async releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    return { kind: "heap", generation: this.generation, usedHeapBytes: 1, heapLimitBytes: 2 };
  }

  drainAndClose(): Promise<void> {
    return Promise.resolve();
  }

  terminate(): Promise<void> {
    this.rejectTermination(new Error("worker terminated"));
    return Promise.resolve();
  }
}

const identity = DaemonWorkspaceIdentity.from(workspaceRoot, canonicalStateDirectory);
const navigationWorker =
  releasePath === undefined && !oversizedResponse
    ? new NodeDaemonNavigationWorker({
        generation: 7,
        stateDirectory: canonicalStateDirectory,
        entryUrl: new URL("./daemon-navigation-worker-fixture.mjs", import.meta.url),
        workerData: {
          mode: "block-execution",
          blockMs: 60_000,
          requestStartedPath: acceptedRequestStartedPath,
        },
      })
    : new ControlledNavigationWorker();
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
  navigationWorker,
});
await daemon.start();
writeFileSync(readyPath, "ready");
