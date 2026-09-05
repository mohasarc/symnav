import type { DaemonNavigationWorker } from "./daemon-navigation-worker.js";
import type {
  DaemonWorkerGenerationManagerOptions,
  DaemonWorkerGenerationSnapshot,
  DaemonWorkerReadyReport,
} from "./daemon-worker-generation-manager-contract.js";

interface DaemonWorkerGeneration {
  readonly worker: DaemonNavigationWorker;
  ready: Promise<DaemonWorkerReadyReport> | undefined;
}

export class DaemonWorkerGenerationManager {
  private readonly generation: DaemonWorkerGeneration;
  private startOperation: Promise<DaemonWorkerReadyReport> | undefined;
  private workerReady = false;
  private fileCount: number | undefined;

  constructor(private readonly options: DaemonWorkerGenerationManagerOptions) {
    const worker = options.initialWorker ?? options.createWorker(1);
    this.generation = { worker, ready: undefined };
  }

  get snapshot(): DaemonWorkerGenerationSnapshot {
    return Object.freeze({
      generation: this.generation.worker.generation,
      ready: this.workerReady,
      ...(this.fileCount === undefined ? {} : { fileCount: this.fileCount }),
    });
  }

  start(): Promise<DaemonWorkerReadyReport> {
    if (this.startOperation !== undefined) return this.startOperation;
    const ready = this.generation.worker
      .start(this.options.workspaceRoot)
      .then((response): DaemonWorkerReadyReport => {
        if (
          response.kind !== "ready" ||
          response.generation !== this.generation.worker.generation
        ) {
          throw new Error("Navigation worker did not become ready");
        }
        this.workerReady = true;
        this.fileCount = response.fileCount;
        return response;
      });
    this.generation.ready = ready;
    this.startOperation = ready;
    return ready;
  }
}
