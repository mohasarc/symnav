import type { DaemonPolicyValues } from "@symnav/daemon";
import type { DaemonWorkerReplacementCause } from "./daemon-protocol.js";

export type DaemonResourceState =
  | "warming"
  | "ready"
  | "active"
  | "shedding"
  | "replacing"
  | "draining"
  | "stopped";

export interface DaemonResourceSnapshot {
  readonly state: DaemonResourceState;
  readonly generation: number;
  readonly processRssBytes: number;
  readonly peakProcessRssBytes: number;
  readonly workerHeapUsedBytes?: number;
  readonly peakWorkerHeapUsedBytes?: number;
  readonly workerHeapLimitBytes?: number;
  readonly spoolBytes: number;
  readonly admissionPaused: boolean;
  readonly replacementCount: number;
}

export interface DaemonResourceSupervisorOptions {
  readonly policy: DaemonPolicyValues["resources"];
  readonly generation: number;
  readonly now?: () => number;
  readonly residentMemoryBytes?: () => number;
  readonly spoolBytes: () => number;
  readonly scheduleAtTurnBoundary: (operation: () => Promise<void>) => Promise<void>;
  readonly releaseTransientResources: () => Promise<void>;
  readonly replaceWorker: (cause: DaemonWorkerReplacementCause) => Promise<number>;
  readonly drain: () => Promise<void>;
}

export type { DaemonWorkerReplacementCause } from "./daemon-protocol.js";

export class DaemonResourceSupervisor {
  private readonly residentMemoryBytes: () => number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentState: DaemonResourceState = "ready";
  private currentGeneration: number;
  private currentProcessRssBytes = 0;
  private peakProcessRssBytes = 0;
  private currentSpoolBytes = 0;
  private admissionPaused = false;
  private shedCompleted = false;
  private shedOperation: Promise<void> | undefined;
  private workerHeapUsedBytes: number | undefined;
  private peakWorkerHeapUsedBytes: number | undefined;
  private workerHeapLimitBytes: number | undefined;
  private replacementCount = 0;
  private replacementTimes: number[] = [];
  private replacementOperation: Promise<void> | undefined;

  constructor(private readonly options: DaemonResourceSupervisorOptions) {
    this.currentGeneration = options.generation;
    this.now = options.now ?? Date.now;
    this.residentMemoryBytes = options.residentMemoryBytes ?? (() => process.memoryUsage().rss);
  }

  get snapshot(): DaemonResourceSnapshot {
    return Object.freeze({
      state: this.currentState,
      generation: this.currentGeneration,
      processRssBytes: this.currentProcessRssBytes,
      peakProcessRssBytes: this.peakProcessRssBytes,
      ...(this.workerHeapUsedBytes === undefined
        ? {}
        : { workerHeapUsedBytes: this.workerHeapUsedBytes }),
      ...(this.peakWorkerHeapUsedBytes === undefined
        ? {}
        : { peakWorkerHeapUsedBytes: this.peakWorkerHeapUsedBytes }),
      ...(this.workerHeapLimitBytes === undefined
        ? {}
        : { workerHeapLimitBytes: this.workerHeapLimitBytes }),
      spoolBytes: this.currentSpoolBytes,
      admissionPaused: this.admissionPaused,
      replacementCount: this.replacementCount,
    });
  }

  start(): void {
    if (this.timer !== undefined || this.currentState === "stopped") return;
    this.timer = setInterval(
      () => void this.sample("interval").catch(() => undefined),
      this.options.policy.supervisionIntervalMs,
    );
    this.timer.unref?.();
  }

  async sample(reason: "warmup" | "interval" | "admission" | "turn-complete"): Promise<void> {
    await this.sampleWithinBoundary(this.options.scheduleAtTurnBoundary);
  }

  async sampleAtTurnBoundary(): Promise<void> {
    await this.sampleWithinBoundary((operation) => operation());
  }

  private async sampleWithinBoundary(
    runAtBoundary: (operation: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    if (this.currentState === "draining" || this.currentState === "stopped") return;
    this.captureUsage();
    const policy = this.options.policy;
    if (this.currentProcessRssBytes >= policy.hardProcessRssBytes) {
      await this.replace("hard-pressure");
      return;
    }
    if (this.currentProcessRssBytes <= policy.resumeProcessRssBytes) {
      this.admissionPaused = false;
      this.shedCompleted = false;
      this.currentState = "ready";
      return;
    }
    if (this.currentProcessRssBytes < policy.softProcessRssBytes) return;
    this.admissionPaused = true;
    this.currentState = "shedding";
    if (this.shedCompleted) return;
    await this.shed(runAtBoundary);
  }

  workerHeapReported(
    generation: number,
    usedBytes: number,
    limitBytes: number,
    peakUsedBytes = usedBytes,
  ): void {
    if (generation !== this.currentGeneration) return;
    this.workerHeapUsedBytes = usedBytes;
    this.workerHeapLimitBytes = limitBytes;
    this.peakWorkerHeapUsedBytes = Math.max(this.peakWorkerHeapUsedBytes ?? 0, peakUsedBytes);
  }

  async recover(exit: import("./daemon-navigation-worker.js").DaemonNavigationWorkerExit) {
    if (exit.generation !== this.currentGeneration || this.currentState === "stopped") return;
    await this.replace(exit.cause === "out-of-memory" ? "out-of-memory" : "worker-exit");
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.currentState = "stopped";
  }

  private captureUsage(): void {
    this.currentProcessRssBytes = this.residentMemoryBytes();
    this.peakProcessRssBytes = Math.max(this.peakProcessRssBytes, this.currentProcessRssBytes);
    this.currentSpoolBytes = this.options.spoolBytes();
  }

  private replace(cause: DaemonWorkerReplacementCause): Promise<void> {
    if (this.replacementOperation !== undefined) return this.replacementOperation;
    const cutoff = this.now() - this.options.policy.replacementWindowMs;
    this.replacementTimes = this.replacementTimes.filter((replacedAt) => replacedAt > cutoff);
    if (this.replacementTimes.length >= this.options.policy.replacementLimit) {
      this.currentState = "draining";
      this.admissionPaused = true;
      this.replacementOperation = this.options.drain().finally(() => {
        this.replacementOperation = undefined;
      });
      return this.replacementOperation;
    }
    this.currentState = "replacing";
    this.admissionPaused = true;
    this.replacementOperation = this.options
      .replaceWorker(cause)
      .then((generation) => {
        this.currentGeneration = generation;
        this.workerHeapUsedBytes = undefined;
        this.workerHeapLimitBytes = undefined;
        this.replacementCount += 1;
        this.replacementTimes.push(this.now());
        this.shedCompleted = false;
        this.admissionPaused = false;
        this.currentState = "ready";
      })
      .catch(async (error: unknown) => {
        this.currentState = "draining";
        await this.options.drain();
        throw error;
      })
      .finally(() => {
        this.replacementOperation = undefined;
      });
    return this.replacementOperation;
  }

  private async shed(
    runAtBoundary: (operation: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    if (this.shedOperation !== undefined) return this.shedOperation;
    const operation = runAtBoundary(async () => {
      try {
        await this.options.releaseTransientResources();
        this.shedCompleted = true;
      } catch (error) {
        await this.replace("shed-failure");
        throw error;
      }
    });
    this.shedOperation = operation;
    try {
      await operation;
    } finally {
      if (this.shedOperation === operation) this.shedOperation = undefined;
    }
  }
}
