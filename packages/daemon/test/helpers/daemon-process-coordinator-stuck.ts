import { writeFileSync } from "node:fs";
import type { DaemonExecutorRequest, DaemonOutputSink } from "../../src/daemon-executor.js";
import type { DaemonCommandName } from "../../src/daemon-command-name.js";
import type {
  DaemonNavigationWorker,
  DaemonNavigationWorkerExit,
} from "../../src/worker/navigation-worker.js";
import type { DaemonNavigationWorkerResponse } from "../../src/worker/worker-protocol.js";
import { DaemonWorkspaceIdentity } from "../../src/registry/workspace-identity.js";
import { CanonicalTestPath } from "./canonical-path.js";
import { TestDaemonProcessCoordinator as DaemonProcessCoordinator } from "./daemon-process-coordinator.js";
import { TestDaemonRegistry as DaemonRegistry } from "./daemon-registry.js";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "./local-daemon-transport.js";

class StuckNavigationWorker implements DaemonNavigationWorker {
  readonly generation = 1;
  readonly exited = new Promise<DaemonNavigationWorkerExit>(() => undefined);
  private rejectExecution!: (error: Error) => void;
  private readonly termination = new Promise<never>((_resolve, reject) => {
    this.rejectExecution = reject;
  });

  constructor(private readonly requestStartedPath: string) {
    void this.termination.catch(() => undefined);
  }

  start(): Promise<DaemonNavigationWorkerResponse> {
    return Promise.resolve({
      kind: "ready",
      generation: this.generation,
      fileCount: 1,
      refresh: { added: 1, changed: 0, removed: 0, unchanged: 0 },
      startupDurations: { discoveryMs: 0, indexingMs: 1, totalMs: 1 },
    });
  }

  async execute(
    _requestId: string,
    _commandName: DaemonCommandName,
    _request: DaemonExecutorRequest,
    _output: DaemonOutputSink,
  ): Promise<DaemonNavigationWorkerResponse> {
    writeFileSync(this.requestStartedPath, "started");
    return this.termination;
  }

  releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    return Promise.resolve({
      kind: "heap",
      generation: this.generation,
      operationId: "controlled-release",
      usedHeapBytes: 1,
      heapLimitBytes: 2,
    });
  }

  drainAndClose(): Promise<void> {
    return Promise.resolve();
  }

  terminate(): Promise<void> {
    this.rejectExecution(new Error("worker terminated"));
    return Promise.resolve();
  }
}

class StuckDaemonActor {
  static async run(arguments_: readonly string[]): Promise<void> {
    const [workspaceRoot, stateDirectory, instanceId, processToken, readyPath, requestStartedPath] =
      arguments_;
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
    const canonicalStateDirectory = CanonicalTestPath.resolve(stateDirectory);
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, canonicalStateDirectory);
    writeFileSync(`${readyPath}.boot`, String(process.pid));
    const daemon = new DaemonProcessCoordinator({
      identity,
      instanceId,
      processToken,
      symnavVersion: "test",
      memoryCapBytes: Number.MAX_SAFE_INTEGER,
      registry: new DaemonRegistry(identity.registryDirectory),
      transport: new LocalDaemonTransport(),
      navigationWorker: new StuckNavigationWorker(requestStartedPath),
    });
    await daemon.start();
    writeFileSync(readyPath, "ready");
  }
}

await StuckDaemonActor.run(process.argv.slice(2));
