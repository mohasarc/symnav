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

  constructor(
    private readonly port: NonNullable<typeof parentPort>,
    private readonly data: NavigationWorkerData,
  ) {}

  run(): void {
    this.port.on("message", (value: unknown) => {
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
      await this.releaseTransientResources();
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
      this.send({
        kind: "result",
        generation: this.data.generation,
        requestId: request.requestId,
        result,
        refresh: this.latestRefresh,
        durations: {
          freshnessMs: 0,
          navigationMs: performance.now() - startedAt,
          renderMs: 0,
          outputMs: 0,
        },
      });
    } catch (error) {
      this.fail("execution", error, request.requestId);
    }
  }

  private async releaseTransientResources(): Promise<void> {
    try {
      await Promise.all(
        this.retainedProgram?.backends.map((backend) => backend.releaseTransientResources()) ?? [],
      );
      const heap = getHeapStatistics();
      this.send({
        kind: "heap",
        generation: this.data.generation,
        usedHeapBytes: heap.used_heap_size,
        heapLimitBytes: heap.heap_size_limit,
      });
    } catch (error) {
      this.fail("resource", error);
    }
  }

  private async close(): Promise<void> {
    await Promise.all(
      this.retainedProgram?.backends.map((backend) => backend.releaseTransientResources()) ?? [],
    );
    this.send({ kind: "closed", generation: this.data.generation });
    this.port.close();
  }

  private fail(failureCode: DaemonExecutionFailureCode, error: unknown, requestId?: string): void {
    this.send({
      kind: "failed",
      generation: this.data.generation,
      ...(requestId === undefined ? {} : { requestId }),
      failureCode,
      ...(error instanceof Error ? { errorName: error.name } : {}),
    });
  }

  private send(response: DaemonNavigationWorkerResponse): void {
    this.port.postMessage(DaemonNavigationWorkerProtocol.response(response));
  }
}

if (parentPort === null) throw new Error("Daemon navigation worker requires a parent port");
const data = workerData as NavigationWorkerData;
new DaemonNavigationWorkerEntry(parentPort, data).run();
