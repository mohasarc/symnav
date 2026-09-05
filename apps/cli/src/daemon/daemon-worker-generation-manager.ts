import type { DaemonOutputSink } from "@symnav/daemon";
import {
  DaemonNavigationWorkerExitedError,
  type DaemonNavigationWorker,
  type DaemonNavigationWorkerExit,
} from "./daemon-navigation-worker.js";
import type { DaemonWorkerReplacementCause } from "./daemon-protocol.js";
import type {
  DaemonWorkerExecuteRequest,
  DaemonWorkerExecutionReport,
  DaemonWorkerGenerationManagerOptions,
  DaemonWorkerGenerationSnapshot,
  DaemonWorkerReadyReport,
} from "./daemon-worker-generation-manager-contract.js";

interface DaemonWorkerGeneration {
  readonly worker: DaemonNavigationWorker;
  ready: Promise<DaemonWorkerReadyReport> | undefined;
}

export class DaemonWorkerGenerationManager {
  private currentGeneration: DaemonWorkerGeneration;
  private startOperation: Promise<DaemonWorkerReadyReport> | undefined;
  private replacementOperation: Promise<DaemonWorkerReadyReport> | undefined;
  private recoveryOperation: Promise<void> | undefined;
  private workerReady = false;
  private fileCount: number | undefined;

  constructor(private readonly options: DaemonWorkerGenerationManagerOptions) {
    const worker = options.initialWorker ?? options.createWorker(1);
    this.currentGeneration = this.createGeneration(worker);
  }

  get snapshot(): DaemonWorkerGenerationSnapshot {
    return Object.freeze({
      generation: this.currentGeneration.worker.generation,
      ready: this.workerReady,
      ...(this.fileCount === undefined ? {} : { fileCount: this.fileCount }),
    });
  }

  start(): Promise<DaemonWorkerReadyReport> {
    if (this.startOperation !== undefined) return this.startOperation;
    const generation = this.currentGeneration;
    generation.ready = this.startGeneration(generation);
    this.startOperation = this.waitForReadyGeneration(generation).then((report) => {
      this.publishReady(generation, report);
      return report;
    });
    return this.startOperation;
  }

  execute(
    requestId: string,
    request: DaemonWorkerExecuteRequest,
    output: DaemonOutputSink,
  ): Promise<DaemonWorkerExecutionReport> {
    const generation = this.currentGeneration;
    const ready = generation.ready ?? this.start();
    return ready
      .then(() =>
        generation.worker.execute(requestId, request.commandName, request.request, output),
      )
      .then((response): DaemonWorkerExecutionReport => {
        if (
          response.kind !== "result" ||
          response.requestId !== requestId ||
          response.generation !== generation.worker.generation
        ) {
          throw new Error("Navigation worker returned an uncorrelated result");
        }
        return response;
      });
  }

  replace(cause: DaemonWorkerReplacementCause): Promise<DaemonWorkerReadyReport> {
    if (this.replacementOperation !== undefined) return this.replacementOperation;
    const operation = this.replaceGeneration(cause);
    this.replacementOperation = operation;
    void operation.then(
      () => this.clearReplacement(operation),
      () => this.clearReplacement(operation),
    );
    return operation;
  }

  private async replaceGeneration(
    cause: DaemonWorkerReplacementCause,
  ): Promise<DaemonWorkerReadyReport> {
    const previous = this.currentGeneration;
    if (cause !== "worker-exit") this.options.onActiveResourceInterruption(cause);
    this.workerReady = false;
    this.fileCount = undefined;
    const nextWorker = this.options.createWorker(previous.worker.generation + 1);
    if (nextWorker.generation !== previous.worker.generation + 1) {
      throw new Error("Navigation worker factory returned the wrong generation");
    }
    const next = this.createGeneration(nextWorker);
    this.currentGeneration = next;
    next.ready = this.startGeneration(next);
    await previous.worker.terminate().catch(() => undefined);
    const report = await next.ready;
    this.publishReady(next, report);
    this.options.onDiagnostic({
      kind: "worker-replaced",
      cause,
      previousWorkerGeneration: previous.worker.generation,
      workerGeneration: next.worker.generation,
      fileCount: report.fileCount,
      ...report.startupDurations,
    });
    return report;
  }

  private startGeneration(generation: DaemonWorkerGeneration): Promise<DaemonWorkerReadyReport> {
    return generation.worker
      .start(this.options.workspaceRoot)
      .then((response): DaemonWorkerReadyReport => {
        if (response.kind !== "ready" || response.generation !== generation.worker.generation) {
          throw new Error("Navigation worker did not become ready");
        }
        return response;
      });
  }

  private async waitForReadyGeneration(
    generation: DaemonWorkerGeneration,
  ): Promise<DaemonWorkerReadyReport> {
    try {
      if (generation.ready === undefined) throw new Error("Navigation worker is not starting");
      return await generation.ready;
    } catch (error) {
      if (!(error instanceof DaemonNavigationWorkerExitedError)) throw error;
      await generation.worker.exited;
      const recovery = this.recoveryOperation;
      if (recovery === undefined) throw error;
      await recovery;
      const replacement = this.currentGeneration;
      if (replacement === generation || replacement.ready === undefined) throw error;
      return replacement.ready;
    }
  }

  private createGeneration(worker: DaemonNavigationWorker): DaemonWorkerGeneration {
    const generation: DaemonWorkerGeneration = { worker, ready: undefined };
    void worker.exited.then((exit) => this.observeExit(generation, exit));
    return generation;
  }

  private observeExit(generation: DaemonWorkerGeneration, exit: DaemonNavigationWorkerExit): void {
    if (generation !== this.currentGeneration) return;
    const recovery = this.options.exitRecovery.recover(exit);
    this.recoveryOperation = recovery;
    void recovery.catch(() => undefined);
  }

  private publishReady(generation: DaemonWorkerGeneration, report: DaemonWorkerReadyReport): void {
    if (generation !== this.currentGeneration) return;
    this.workerReady = true;
    this.fileCount = report.fileCount;
  }

  private clearReplacement(operation: Promise<DaemonWorkerReadyReport>): void {
    if (this.replacementOperation === operation) this.replacementOperation = undefined;
  }
}
