import { existsSync, writeFileSync } from "node:fs";
import type {
  DaemonExecutorExecutionResult,
  DaemonExecutorRequest,
  DaemonOutputRecord,
  DaemonSequencedOutputRecord,
} from "../../src/daemon-executor.js";
import { DaemonExecutorModuleLoader } from "../../src/daemon-executor.js";
import { DaemonPolicy, DaemonPolicyCodec } from "../../src/daemon-policy.js";
import { DaemonWorkspaceIdentity } from "../../src/registry/workspace-identity.js";
import { TestDaemonRegistry as DaemonRegistry } from "../helpers/daemon-registry.js";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "../helpers/local-daemon-transport.js";
import type {
  DaemonNavigationWorker,
  DaemonNavigationWorkerExit,
} from "../../src/worker/navigation-worker.js";
import { NodeDaemonNavigationWorker } from "../../src/worker/navigation-worker.js";
import type { DaemonNavigationWorkerResponse } from "../../src/worker/worker-protocol.js";
import { CanonicalTestPath } from "../helpers/canonical-path.js";
import { TestDaemonProcessCoordinator as DaemonProcessCoordinator } from "../helpers/daemon-process-coordinator.js";

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
const canonicalStateDirectory = CanonicalTestPath.resolve(stateDirectory);
const daemonPolicy = DaemonPolicy.currentSystem();
const executorModuleUrl = new URL("../../../../apps/cli/dist/daemon-executor.js", import.meta.url)
  .href;
const executor = await DaemonExecutorModuleLoader.load(executorModuleUrl, {
  stateDirectory: canonicalStateDirectory,
  productVersion: symnavVersion,
  sampleResources: () => undefined,
});
await executor.initialize(workspaceRoot);
let executionCount = 0;

class ControlledExecutor {
  async execute(request: DaemonExecutorRequest): Promise<DaemonExecutorExecutionResult> {
    executionCount += 1;
    writeFileSync(acceptedRequestStartedPath, "started");
    writeFileSync(`${acceptedRequestStartedPath}.${executionCount}`, "started");
    if (oversizedResponse || oversizedJsonResponse) {
      const result = await executor.execute(request);
      const records: Omit<DaemonOutputRecord, "sequence">[] = [];
      if (oversizedJsonResponse) {
        records.push({
          stream: "stdout",
          bytes: Buffer.from(`${JSON.stringify({ data: "x".repeat(9 * 1024 * 1024) })}\n`),
        });
      } else {
        for await (const record of result.output?.records() ?? []) {
          records.push({ stream: record.stream, bytes: record.bytes });
        }
        records.push({
          stream: "stdout",
          bytes: Buffer.alloc(9 * 1024 * 1024, "x"),
        });
      }
      await result.output?.dispose();
      return { exitCode: result.exitCode, output: new ActorExecutorOutput(records) };
    }
    if (releasePath === undefined) return new Promise(() => undefined);
    while (!existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return executor.execute(request);
  }
}

class ActorExecutorOutput {
  private readonly recordsBySequence: readonly DaemonSequencedOutputRecord[];

  constructor(records: readonly Omit<DaemonOutputRecord, "sequence">[]) {
    this.recordsBySequence = records
      .flatMap((record) => ActorExecutorOutput.chunks(record))
      .map((record, sequence) => ({ ...record, sequence }));
  }

  async *records(): AsyncIterable<DaemonSequencedOutputRecord> {
    yield* this.recordsBySequence;
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  private static chunks(
    record: Omit<DaemonOutputRecord, "sequence">,
  ): readonly Omit<DaemonOutputRecord, "sequence">[] {
    const chunkBytes = DaemonPolicy.currentSystem().values.output.maximumChunkRawBytes;
    const chunks: Omit<DaemonOutputRecord, "sequence">[] = [];
    for (let offset = 0; offset < record.bytes.byteLength; offset += chunkBytes) {
      chunks.push({
        stream: record.stream,
        bytes: record.bytes.slice(offset, offset + chunkBytes),
      });
    }
    return chunks;
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
    request: DaemonExecutorRequest,
    output: { append(record: DaemonSequencedOutputRecord): Promise<void> },
  ): Promise<DaemonNavigationWorkerResponse> {
    const result = await Promise.race([this.controlledExecutor.execute(request), this.termination]);
    let sequence = 0;
    for await (const record of result.output.records()) {
      await output.append({ ...record, sequence });
      sequence += 1;
    }
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
        executorModuleUrl,
        policy: DaemonPolicyCodec.serialize(daemonPolicy),
      },
      resourceLimits: { maxOldGenerationSizeMb: 4096 },
      entryUrl: new URL(
        "../../../../apps/cli/test/helpers/daemon-navigation-worker-fixture.mjs",
        import.meta.url,
      ),
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
          executorModuleUrl,
          policy: DaemonPolicyCodec.serialize(daemonPolicy),
        },
        resourceLimits: { maxOldGenerationSizeMb: 4096 },
        entryUrl: new URL(
          "../../../../apps/cli/test/helpers/daemon-navigation-worker-fixture.mjs",
          import.meta.url,
        ),
        workerData: {
          mode: "block-execution",
          blockMs: 60_000,
          requestStartedPath: acceptedRequestStartedPath,
        },
      })
    : new ControlledNavigationWorker();
writeFileSync(`${readyPath}.boot`, String(process.pid));
const daemon = new DaemonProcessCoordinator({
  identity,
  instanceId,
  processToken,
  symnavVersion,
  memoryCapBytes: Number.MAX_SAFE_INTEGER,
  policy: daemonPolicy,
  registry: new DaemonRegistry(identity.registryDirectory),
  transport: new LocalDaemonTransport(),
  navigationWorker,
});
await daemon.start();
writeFileSync(readyPath, "ready");
