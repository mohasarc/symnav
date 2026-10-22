import { parentPort, workerData } from "node:worker_threads";
import { getHeapStatistics } from "node:v8";
import {
  DaemonExecutorModuleLoader,
  DaemonPolicy,
  type DaemonDiagnostics,
  type DaemonExecutor,
  type DaemonExecutorModuleUrl,
  type DaemonOutputRecord,
  type DaemonWorkerFailureCode,
} from "@symnav/daemon";
import {
  DaemonNavigationWorkerProtocol,
  type WorkerCommandDurations,
  type DaemonNavigationWorkerRequest,
  type DaemonNavigationWorkerResponse,
} from "./worker-protocol.js";
import type { DaemonRefreshSummary } from "../transport/protocol.js";
import { NodeDaemonClock } from "../lifecycle/daemon-clock.js";

interface DaemonWorkerData {
  readonly stateDirectory: string;
  readonly generation: number;
  readonly productVersion: string;
  readonly executorModuleUrl: DaemonExecutorModuleUrl;
  readonly policy: ReturnType<DaemonPolicy["toSerialized"]>;
}

class DaemonNavigationWorkerEntry {
  private executor: DaemonExecutor | undefined;
  private activeHeapMonitor: WorkerHeapHighWater | undefined;
  private tail: Promise<void> = Promise.resolve();
  private readonly outputAcknowledgements = new Map<string, () => void>();
  private readonly policy: DaemonPolicy;
  private readonly clock = new NodeDaemonClock();

  constructor(
    private readonly port: NonNullable<typeof parentPort>,
    private readonly data: DaemonWorkerData,
  ) {
    this.policy = DaemonPolicy.fromSerialized(data.policy);
  }

  run(): void {
    this.port.on("message", (value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "output-ack"
      ) {
        try {
          const request = DaemonNavigationWorkerProtocol.request(value);
          if (request.kind !== "output-ack") throw new Error("Invalid output acknowledgement");
          this.acknowledgeOutput(request.requestId, request.sequence);
          return;
        } catch (error) {
          this.fail("protocol", error);
          return;
        }
      }
      this.tail = this.tail.then(() => this.handle(value));
    });
  }

  private async handle(value: unknown): Promise<void> {
    let request: DaemonNavigationWorkerRequest;
    try {
      request = DaemonNavigationWorkerProtocol.request(value);
    } catch (error) {
      this.fail("protocol", error);
      return;
    }
    if (request.generation !== this.data.generation) return;
    if (request.kind === "initialize") {
      await this.initialize(request.workspaceRoot);
      return;
    }
    if (request.kind === "execute") {
      await this.execute(request);
      return;
    }
    if (request.kind === "release-transient") {
      await this.releaseTransientResources(request.operationId);
      return;
    }
    await this.close();
  }

  private async initialize(workspaceRoot: string): Promise<void> {
    const startedAt = this.clock.monotonicNowMs();
    try {
      this.executor = await DaemonExecutorModuleLoader.load(this.data.executorModuleUrl, {
        stateDirectory: this.data.stateDirectory,
        productVersion: this.data.productVersion,
        sampleResources: () => this.activeHeapMonitor?.sample(),
      });
      const initialized = await this.executor.initialize(workspaceRoot);
      const totalMs = this.clock.monotonicNowMs() - startedAt;
      this.send({
        kind: "ready",
        generation: this.data.generation,
        fileCount: initialized.fileCount,
        refresh: DaemonWorkerDiagnosticProjection.refresh(initialized.diagnostics),
        startupDurations: {
          ...DaemonWorkerDiagnosticProjection.startupDurations(initialized.diagnostics),
          totalMs,
        },
        ...(initialized.diagnostics === undefined ? {} : { diagnostics: initialized.diagnostics }),
      });
    } catch (error) {
      this.fail("initialization", error);
    }
  }

  private async execute(request: Extract<DaemonNavigationWorkerRequest, { kind: "execute" }>) {
    const heapMonitor = new WorkerHeapHighWater(
      this.policy.values.resources.workerHeapSampleIntervalMs,
    );
    this.activeHeapMonitor = heapMonitor;
    try {
      if (this.executor === undefined) throw new Error("Navigation worker is not ready");
      const result = await this.executor.execute(request.request);
      heapMonitor.sample();
      const outputStartedAt = this.clock.monotonicNowMs();
      let sequence = 0;
      for await (const record of result.output.records()) {
        sequence = await this.sendOutput(request.requestId, sequence, record);
        heapMonitor.sample();
      }
      await result.output.dispose();
      const outputMs = this.clock.monotonicNowMs() - outputStartedAt;
      const resources = heapMonitor.finish();
      this.send({
        kind: "result",
        generation: this.data.generation,
        requestId: request.requestId,
        result: { exitCode: result.exitCode },
        refresh: DaemonWorkerDiagnosticProjection.refresh(result.diagnostics),
        durations: {
          ...DaemonWorkerDiagnosticProjection.commandDurations(result.diagnostics),
          outputMs,
        },
        ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
        resources,
      });
    } catch (error) {
      this.fail("execution", error, { requestId: request.requestId });
    } finally {
      heapMonitor.close();
      this.activeHeapMonitor = undefined;
    }
  }

  private async releaseTransientResources(operationId: string): Promise<void> {
    try {
      await this.executor?.releaseTransientResources();
      const heap = getHeapStatistics();
      this.send({
        kind: "heap",
        generation: this.data.generation,
        operationId,
        usedHeapBytes: heap.used_heap_size,
        heapLimitBytes: heap.heap_size_limit,
      });
    } catch (error) {
      this.fail("resource", error, { operationId });
    }
  }

  private async close(): Promise<void> {
    await this.executor?.releaseTransientResources();
    this.send({ kind: "closed", generation: this.data.generation });
    this.port.close();
  }

  private fail(
    failureCode: DaemonWorkerFailureCode,
    error: unknown,
    correlation:
      | { readonly requestId: string }
      | { readonly operationId: string }
      | undefined = undefined,
  ): void {
    this.send({
      kind: "failed",
      generation: this.data.generation,
      ...correlation,
      failureCode,
      ...(error instanceof Error ? { errorName: error.name } : {}),
    });
  }

  private send(response: DaemonNavigationWorkerResponse): void {
    const validated = DaemonNavigationWorkerProtocol.response(
      response,
      this.policy.values.output.maximumChunkRawBytes,
    );
    if (validated.kind === "output-chunk") {
      this.port.postMessage(validated, [validated.bytes.buffer as ArrayBuffer]);
      return;
    }
    this.port.postMessage(validated);
  }

  private sendOutput(
    requestId: string,
    initialSequence: number,
    record: DaemonOutputRecord,
  ): Promise<number> {
    return this.sendOutputChunks(requestId, initialSequence, record);
  }

  private async sendOutputChunks(
    requestId: string,
    initialSequence: number,
    record: DaemonOutputRecord,
  ): Promise<number> {
    let sequence = initialSequence;
    if (record.bytes.byteLength === 0) {
      await this.sendOutputChunk(requestId, sequence, record.stream, new Uint8Array());
      return sequence + 1;
    }
    for (
      let offset = 0;
      offset < record.bytes.byteLength;
      offset += this.policy.values.output.maximumChunkRawBytes
    ) {
      const bytes = Uint8Array.from(
        record.bytes.subarray(offset, offset + this.policy.values.output.maximumChunkRawBytes),
      );
      await this.sendOutputChunk(requestId, sequence, record.stream, bytes);
      sequence += 1;
    }
    return sequence;
  }

  private sendOutputChunk(
    requestId: string,
    sequence: number,
    stream: DaemonOutputRecord["stream"],
    bytes: Uint8Array,
  ): Promise<void> {
    const key = `${requestId}:${sequence}`;
    if (this.outputAcknowledgements.has(key)) {
      return Promise.reject(new Error("Duplicate worker output sequence"));
    }
    const acknowledgement = new Promise<void>((resolve) => {
      this.outputAcknowledgements.set(key, resolve);
    });
    this.send({
      kind: "output-chunk",
      generation: this.data.generation,
      requestId,
      sequence,
      stream,
      bytes,
    });
    return acknowledgement;
  }

  private acknowledgeOutput(requestId: string, sequence: number): void {
    const key = `${requestId}:${sequence}`;
    const resolve = this.outputAcknowledgements.get(key);
    if (resolve === undefined) throw new Error("Unexpected worker output acknowledgement");
    this.outputAcknowledgements.delete(key);
    resolve();
  }
}

class DaemonWorkerDiagnosticProjection {
  private static readonly emptyRefresh: DaemonRefreshSummary = {
    added: 0,
    changed: 0,
    removed: 0,
    unchanged: 0,
  };

  static refresh(diagnostics: DaemonDiagnostics | undefined): DaemonRefreshSummary {
    const refresh = this.record(diagnostics?.refresh);
    if (refresh === undefined) return this.emptyRefresh;
    return {
      added: this.count(refresh.added),
      changed: this.count(refresh.changed),
      removed: this.count(refresh.removed),
      unchanged: this.count(refresh.unchanged),
    };
  }

  static startupDurations(diagnostics: DaemonDiagnostics | undefined): {
    readonly discoveryMs: number;
    readonly indexingMs: number;
  } {
    const durations = this.record(diagnostics?.durations);
    return {
      discoveryMs: this.duration(durations?.discoveryMs),
      indexingMs: this.duration(durations?.indexingMs),
    };
  }

  static commandDurations(
    diagnostics: DaemonDiagnostics | undefined,
  ): Omit<WorkerCommandDurations, "outputMs"> {
    const durations = this.record(diagnostics?.durations);
    return {
      freshnessMs: this.duration(durations?.freshnessMs),
      navigationMs: this.duration(durations?.navigationMs),
      renderMs: this.duration(durations?.renderMs),
    };
  }

  private static record(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  }

  private static count(value: unknown): number {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
  }

  private static duration(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  }
}

class WorkerHeapHighWater {
  private currentUsedBytes = 0;
  private peakUsedBytes = 0;
  private heapLimitBytes = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(sampleIntervalMs: number) {
    this.sample();
    this.timer = setInterval(() => this.sample(), sampleIntervalMs);
    this.timer.unref?.();
  }

  sample(): void {
    const heap = getHeapStatistics();
    this.currentUsedBytes = heap.used_heap_size;
    this.peakUsedBytes = Math.max(this.peakUsedBytes, this.currentUsedBytes);
    this.heapLimitBytes = heap.heap_size_limit;
  }

  finish(): {
    readonly workerHeapUsedBytes: number;
    readonly peakWorkerHeapUsedBytes: number;
    readonly workerHeapLimitBytes: number;
  } {
    this.sample();
    this.close();
    return {
      workerHeapUsedBytes: this.currentUsedBytes,
      peakWorkerHeapUsedBytes: this.peakUsedBytes,
      workerHeapLimitBytes: this.heapLimitBytes,
    };
  }

  close(): void {
    clearInterval(this.timer);
  }
}

if (parentPort === null) throw new Error("Daemon navigation worker requires a parent port");
const data = workerData as DaemonWorkerData;
new DaemonNavigationWorkerEntry(parentPort, data).run();
