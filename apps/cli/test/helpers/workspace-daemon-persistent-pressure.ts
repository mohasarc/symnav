import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { DaemonPolicy } from "@symnav/daemon";
import { StateDirectoryResolver } from "../../src/state-directory-resolver.js";
import type {
  CliExecutionRequest,
  CommandOutputRecord,
} from "../../src/command-execution-result.js";
import { createDefaultDependencies } from "../../src/program.js";
import { TestDaemonRegistry as DaemonRegistry } from "./daemon-registry.js";
import { TestDaemonResourcePolicy as DaemonResourcePolicy } from "./daemon-resource-policy.js";
import { DaemonWorkspaceIdentity } from "../../src/daemon/daemon-workspace-identity.js";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "./local-daemon-transport.js";
import type {
  DaemonNavigationWorker,
  DaemonNavigationWorkerExit,
} from "../../src/daemon/daemon-navigation-worker.js";
import type { DaemonNavigationWorkerResponse } from "../../src/daemon/daemon-navigation-worker-protocol.js";
import { TestWorkspaceDaemon as WorkspaceDaemon } from "./workspace-daemon.js";

const [
  workspaceRoot,
  stateDirectory,
  instanceId,
  processToken,
  readyPath,
  requestStartedPath,
  pressurePath,
  executionOrderPath,
  symnavVersion,
] = process.argv.slice(2);
if (
  workspaceRoot === undefined ||
  stateDirectory === undefined ||
  instanceId === undefined ||
  processToken === undefined ||
  readyPath === undefined ||
  requestStartedPath === undefined ||
  pressurePath === undefined ||
  executionOrderPath === undefined ||
  symnavVersion === undefined
) {
  process.exit(2);
}

class PressureNavigationWorker implements DaemonNavigationWorker {
  readonly exited: Promise<DaemonNavigationWorkerExit>;
  private resolveExited!: (exit: DaemonNavigationWorkerExit) => void;
  private rejectBlockedExecution!: (error: Error) => void;
  private readonly blockedExecution: Promise<never>;
  private terminated = false;

  constructor(
    readonly generation: number,
    private readonly startedPath: string,
    private readonly orderPath: string,
  ) {
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.blockedExecution = new Promise((_resolve, reject) => {
      this.rejectBlockedExecution = reject;
    });
    void this.blockedExecution.catch(() => undefined);
  }

  start(): Promise<DaemonNavigationWorkerResponse> {
    return Promise.resolve({
      kind: "ready",
      generation: this.generation,
      fileCount: 3,
      refresh: { added: 3, changed: 0, removed: 0, unchanged: 0 },
      startupDurations: { discoveryMs: 0, indexingMs: 1, totalMs: 1 },
    });
  }

  async execute(
    requestId: string,
    _commandName: Parameters<DaemonNavigationWorker["execute"]>[1],
    request: CliExecutionRequest,
    output: { append(record: CommandOutputRecord): Promise<void> },
  ): Promise<DaemonNavigationWorkerResponse> {
    appendFileSync(this.orderPath, `${request.argv.join(" ")}@${this.generation}\n`);
    if (this.generation === 1) {
      writeFileSync(this.startedPath, "started");
      return this.blockedExecution;
    }
    await output.append({
      sequence: 0,
      stream: "stdout",
      bytes: Buffer.from(`worker generation ${this.generation}\n`),
    });
    return {
      kind: "result",
      generation: this.generation,
      requestId,
      result: { exitCode: 0 },
      refresh: { added: 0, changed: 0, removed: 0, unchanged: 3 },
      durations: { freshnessMs: 0, navigationMs: 1, renderMs: 0, outputMs: 0 },
      resources: {
        workerHeapUsedBytes: 1,
        peakWorkerHeapUsedBytes: 1,
        workerHeapLimitBytes: 2,
      },
    };
  }

  releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    return Promise.resolve({
      kind: "heap",
      generation: this.generation,
      operationId: `pressure-release-${this.generation}`,
      usedHeapBytes: 1,
      heapLimitBytes: 2,
    });
  }

  drainAndClose(): Promise<void> {
    if (!this.terminated) {
      this.terminated = true;
      this.resolveExited({ generation: this.generation, cause: "closed" });
    }
    return Promise.resolve();
  }

  terminate(): Promise<void> {
    if (!this.terminated) {
      this.terminated = true;
      this.rejectBlockedExecution(new Error("worker terminated by resource pressure"));
      this.resolveExited({ generation: this.generation, cause: "terminated" });
    }
    return Promise.resolve();
  }
}

const canonicalStateDirectory = StateDirectoryResolver.canonicalize(stateDirectory);
const identity = DaemonWorkspaceIdentity.from(workspaceRoot, canonicalStateDirectory);
const policy = DaemonResourcePolicy.fromSystemMemory(512 * 1024 * 1024);
const daemonPolicy = DaemonPolicy.currentSystem();
writeFileSync(`${readyPath}.boot`, String(process.pid));
const daemon = new WorkspaceDaemon({
  identity,
  instanceId,
  processToken,
  symnavVersion,
  memoryCapBytes: policy.record.hardProcessRssBytes,
  policy: daemonPolicy,
  dependencies: createDefaultDependencies(canonicalStateDirectory, daemonPolicy),
  registry: new DaemonRegistry(identity.registryDirectory),
  transport: new LocalDaemonTransport(),
  navigationWorkerFactory: (generation) =>
    new PressureNavigationWorker(generation, requestStartedPath, executionOrderPath),
  resourcePolicy: policy,
  resourceCheckIntervalMs: 2_000,
  residentMemoryBytes: () => (existsSync(pressurePath) ? policy.record.hardProcessRssBytes + 1 : 0),
});
await daemon.start();
writeFileSync(readyPath, "ready");
