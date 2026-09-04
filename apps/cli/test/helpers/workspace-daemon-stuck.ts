import { existsSync, writeFileSync } from "node:fs";
import { DaemonPolicy } from "@symnav/daemon";
import { StateDirectoryResolver } from "../../src/state-directory-resolver.js";
import type {
  CliExecutionRequest,
  CommandExecutionResult,
  CommandOutputRecord,
} from "../../src/command-execution-result.js";
import { OrderedCommandOutput } from "../../src/command-execution-result.js";
import { createDefaultDependencies } from "../../src/program.js";
import { CliProgramExecutor } from "../../src/cli-program-executor.js";
import { TestDaemonRegistry as DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../src/daemon/daemon-workspace-identity.js";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "./local-daemon-transport.js";
import type {
  DaemonNavigationWorker,
  DaemonNavigationWorkerExit,
} from "../../src/daemon/daemon-navigation-worker.js";
import { NodeDaemonNavigationWorker } from "../../src/daemon/daemon-navigation-worker.js";
import type { DaemonNavigationWorkerResponse } from "../../src/daemon/daemon-navigation-worker-protocol.js";
import { TestWorkspaceDaemon as WorkspaceDaemon } from "./workspace-daemon.js";

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
const oversizedJsonResponse = releasePathArgument === "--oversized-json-response";
const workerExit = releasePathArgument === "--worker-exit";
const releasePath =
  releasePathArgument === "--no-release" || oversizedResponse || oversizedJsonResponse || workerExit
    ? undefined
    : releasePathArgument;
const symnavVersion = configuredSymnavVersion ?? "test";
const canonicalStateDirectory = StateDirectoryResolver.canonicalize(stateDirectory);
const daemonPolicy = DaemonPolicy.currentSystem();
const dependencies = createDefaultDependencies(canonicalStateDirectory, daemonPolicy);
const retainedBackends = dependencies.backends();
const executor = new CliProgramExecutor({ ...dependencies, backends: () => retainedBackends });
let executionCount = 0;

class ControlledExecutor {
  async execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    executionCount += 1;
    writeFileSync(acceptedRequestStartedPath, "started");
    writeFileSync(`${acceptedRequestStartedPath}.${executionCount}`, "started");
    if (oversizedResponse || oversizedJsonResponse) {
      const result = await executor.execute(request);
      const output = new OrderedCommandOutput({ policy: daemonPolicy.values.output });
      if (oversizedJsonResponse) {
        await writeRecord(output, {
          sequence: 0,
          stream: "stdout",
          bytes: Buffer.from(`${JSON.stringify({ data: "x".repeat(9 * 1024 * 1024) })}\n`),
        });
      } else {
        for await (const record of result.output?.records() ?? []) {
          await writeRecord(output, record);
        }
        await writeRecord(output, {
          sequence: result.output?.summary.recordCount ?? 0,
          stream: "stdout",
          bytes: Buffer.alloc(9 * 1024 * 1024, "x"),
        });
      }
      await result.output?.dispose();
      return output.finish(result.exitCode);
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
    _commandName: Parameters<DaemonNavigationWorker["execute"]>[1],
    request: CliExecutionRequest,
    output: { append(record: CommandOutputRecord): Promise<void> },
  ): Promise<DaemonNavigationWorkerResponse> {
    const result = await Promise.race([this.controlledExecutor.execute(request), this.termination]);
    for await (const record of result.output.records()) await output.append(record);
    await result.output.dispose();
    return {
      kind: "result",
      generation: this.generation,
      requestId,
      result: { exitCode: result.exitCode },
      refresh: { added: 0, changed: 0, removed: 0, unchanged: 1 },
      durations: { freshnessMs: 0, navigationMs: 1, renderMs: 0, outputMs: 0 },
      resources: {
        workerHeapUsedBytes: 1,
        peakWorkerHeapUsedBytes: 1,
        workerHeapLimitBytes: 2,
      },
    };
  }

  async releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    return {
      kind: "heap",
      generation: this.generation,
      operationId: "controlled-release",
      usedHeapBytes: 1,
      heapLimitBytes: 2,
    };
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
const workerExitReleasePath = `${acceptedRequestStartedPath}.release-worker-exit`;
const navigationWorker = workerExit
  ? new NodeDaemonNavigationWorker({
      generation: 7,
      configuration: {
        stateDirectory: canonicalStateDirectory,
        productVersion: symnavVersion,
        executorModuleUrl: new URL("../../dist/daemon-executor.js", import.meta.url).href,
        policy: dependencies.daemonPolicy.toSerialized(),
      },
      resourceLimits: { maxOldGenerationSizeMb: 4096 },
      entryUrl: new URL("./daemon-navigation-worker-fixture.mjs", import.meta.url),
      workerData: {
        mode: "exit-on-release",
        requestPayloadPath: `${acceptedRequestStartedPath}.payload`,
        requestStartedPath: acceptedRequestStartedPath,
        releasePath: workerExitReleasePath,
      },
    })
  : releasePath === undefined && !oversizedResponse && !oversizedJsonResponse
    ? new NodeDaemonNavigationWorker({
        generation: 7,
        configuration: {
          stateDirectory: canonicalStateDirectory,
          productVersion: symnavVersion,
          executorModuleUrl: new URL("../../dist/daemon-executor.js", import.meta.url).href,
          policy: dependencies.daemonPolicy.toSerialized(),
        },
        resourceLimits: { maxOldGenerationSizeMb: 4096 },
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
  policy: daemonPolicy,
  dependencies,
  registry: new DaemonRegistry(identity.registryDirectory),
  transport: new LocalDaemonTransport(),
  navigationWorker,
});
await daemon.start();
writeFileSync(readyPath, "ready");

function writeRecord(output: OrderedCommandOutput, record: CommandOutputRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    output[record.stream].write(record.bytes, (error) => (error ? reject(error) : resolve()));
  });
}
