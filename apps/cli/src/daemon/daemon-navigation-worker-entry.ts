import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import { getHeapStatistics } from "node:v8";
import type { BackendRefreshSummary } from "@symnav/core";
import { createDefaultDependencies } from "../program.js";
import { RetainedWorkspaceProgram } from "./retained-workspace-program.js";
import {
  DaemonNavigationWorkerProtocol,
  type DaemonExecutionFailureCode,
  type DaemonNavigationWorkerRequest,
  type DaemonNavigationWorkerResponse,
} from "./daemon-navigation-worker-protocol.js";

interface NavigationWorkerData {
  readonly stateDirectory: string;
  readonly generation: number;
}

class DaemonNavigationWorkerEntry {
  private retainedProgram: RetainedWorkspaceProgram | undefined;
  private latestRefresh: BackendRefreshSummary = {
    added: 0,
    changed: 0,
    removed: 0,
    unchanged: 0,
  };
  private tail: Promise<void> = Promise.resolve();
  private readonly outputAcknowledgements = new Map<string, () => void>();

  constructor(
    private readonly port: NonNullable<typeof parentPort>,
    private readonly data: NavigationWorkerData,
  ) {}

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
    const startedAt = performance.now();
    try {
      const dependencies = createDefaultDependencies(this.data.stateDirectory);
      this.retainedProgram = new RetainedWorkspaceProgram(dependencies, (refresh) => {
        this.latestRefresh = refresh;
      });
      const prepared = await this.retainedProgram.scopeFactory.prepare(workspaceRoot);
      this.latestRefresh = prepared.refresh;
      const totalMs = performance.now() - startedAt;
      this.send({
        kind: "ready",
        generation: this.data.generation,
        fileCount: prepared.refresh.added + prepared.refresh.unchanged,
        refresh: prepared.refresh,
        startupDurations: { discoveryMs: 0, indexingMs: totalMs, totalMs },
      });
    } catch (error) {
      this.fail("initialization", error);
    }
  }

  private async execute(request: Extract<DaemonNavigationWorkerRequest, { kind: "execute" }>) {
    const startedAt = performance.now();
    try {
      if (this.retainedProgram === undefined) throw new Error("Navigation worker is not ready");
      const result = await this.retainedProgram.execute(request.request);
      for await (const record of result.output?.records() ?? []) {
        await this.sendOutput(request.requestId, record);
      }
      await result.output?.dispose();
      this.send({
        kind: "result",
        generation: this.data.generation,
        requestId: request.requestId,
        result: { exitCode: result.exitCode },
        refresh: this.latestRefresh,
        durations: {
          freshnessMs: 0,
          navigationMs: performance.now() - startedAt,
          renderMs: 0,
          outputMs: 0,
        },
      });
    } catch (error) {
      this.fail("execution", error, { requestId: request.requestId });
    }
  }

  private async releaseTransientResources(operationId: string): Promise<void> {
    try {
      await Promise.all(
        this.retainedProgram?.backends.map((backend) => backend.releaseTransientResources()) ?? [],
      );
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
    await Promise.all(
      this.retainedProgram?.backends.map((backend) => backend.releaseTransientResources()) ?? [],
    );
    this.send({ kind: "closed", generation: this.data.generation });
    this.port.close();
  }

  private fail(
    failureCode: DaemonExecutionFailureCode,
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
    const validated = DaemonNavigationWorkerProtocol.response(response);
    if (validated.kind === "output-chunk") {
      this.port.postMessage(validated, [validated.bytes.buffer as ArrayBuffer]);
      return;
    }
    this.port.postMessage(validated);
  }

  private sendOutput(
    requestId: string,
    record: import("../command-execution-result.js").CommandOutputRecord,
  ): Promise<void> {
    const key = `${requestId}:${record.sequence}`;
    if (this.outputAcknowledgements.has(key)) {
      return Promise.reject(new Error("Duplicate worker output sequence"));
    }
    const acknowledgement = new Promise<void>((resolve) => {
      this.outputAcknowledgements.set(key, resolve);
    });
    const bytes = Uint8Array.from(record.bytes);
    this.send({
      kind: "output-chunk",
      generation: this.data.generation,
      requestId,
      sequence: record.sequence,
      stream: record.stream,
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

if (parentPort === null) throw new Error("Daemon navigation worker requires a parent port");
const data = workerData as NavigationWorkerData;
new DaemonNavigationWorkerEntry(parentPort, data).run();
