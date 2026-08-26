const MEBIBYTE = 1024 * 1024;
const MINIMUM_PROCESS_MEMORY_MIB = 256;
const MAXIMUM_PROCESS_MEMORY_MIB = 8 * 1024;
const MINIMUM_WORKER_OLD_GENERATION_MIB = 128;
const MAXIMUM_WORKER_OLD_GENERATION_MIB = 4 * 1024;
const DEFAULT_CHECK_INTERVAL_MS = 5_000;

export const DAEMON_RESOURCE_SAMPLE_INTERVAL_MS = 250;
export const DAEMON_RESOURCE_RESTART_WINDOW_MS = 10 * 60 * 1000;
export const DAEMON_RESOURCE_RESTART_LIMIT = 2;

export interface DaemonResourcePolicyRecord {
  readonly effectiveMemoryBytes: number;
  readonly hardProcessRssBytes: number;
  readonly softProcessRssBytes: number;
  readonly resumeProcessRssBytes: number;
  readonly workerMaxOldGenerationSizeMb: number;
}

export class DaemonResourcePolicy {
  private constructor(readonly record: DaemonResourcePolicyRecord) {}

  static fromSystemMemory(
    totalMemoryBytes: number,
    constrainedMemoryBytes?: number,
  ): DaemonResourcePolicy {
    const effectiveMemoryBytes =
      constrainedMemoryBytes !== undefined &&
      constrainedMemoryBytes > 0 &&
      constrainedMemoryBytes < totalMemoryBytes
        ? constrainedMemoryBytes
        : totalMemoryBytes;
    const effectiveMemoryMib = Math.max(1, Math.floor(effectiveMemoryBytes / MEBIBYTE));
    const hardProcessRssMib = DaemonResourcePolicy.clamp(
      Math.floor(effectiveMemoryMib / 2),
      MINIMUM_PROCESS_MEMORY_MIB,
      MAXIMUM_PROCESS_MEMORY_MIB,
    );
    const workerMaxOldGenerationSizeMb = DaemonResourcePolicy.clamp(
      Math.floor(effectiveMemoryMib / 4),
      MINIMUM_WORKER_OLD_GENERATION_MIB,
      MAXIMUM_WORKER_OLD_GENERATION_MIB,
    );
    return new DaemonResourcePolicy({
      effectiveMemoryBytes,
      hardProcessRssBytes: hardProcessRssMib * MEBIBYTE,
      softProcessRssBytes: Math.floor(hardProcessRssMib * 0.8) * MEBIBYTE,
      resumeProcessRssBytes: Math.floor(hardProcessRssMib * 0.7) * MEBIBYTE,
      workerMaxOldGenerationSizeMb,
    });
  }

  private static clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
  }
}

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
  readonly workerHeapLimitBytes?: number;
  readonly spoolBytes: number;
  readonly admissionPaused: boolean;
  readonly replacementCount: number;
}

export interface DaemonResourceSupervisorOptions {
  readonly policy: DaemonResourcePolicy;
  readonly generation: number;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly residentMemoryBytes?: () => number;
  readonly spoolBytes: () => number;
  readonly releaseTransientResources: () => Promise<void>;
  readonly replaceWorker: () => Promise<number>;
  readonly drain: () => Promise<void>;
}

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
  private shedPending = false;
  private shedCompleted = false;
  private workerHeapUsedBytes: number | undefined;
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
      this.options.intervalMs ?? DAEMON_RESOURCE_SAMPLE_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  async sample(reason: "interval" | "admission" | "turn-complete"): Promise<void> {
    if (this.currentState === "draining" || this.currentState === "stopped") return;
    this.captureUsage();
    const policy = this.options.policy.record;
    if (this.currentProcessRssBytes >= policy.hardProcessRssBytes) {
      await this.replace();
      return;
    }
    if (this.currentProcessRssBytes <= policy.resumeProcessRssBytes) {
      this.admissionPaused = false;
      this.shedPending = false;
      this.shedCompleted = false;
      this.currentState = "ready";
      return;
    }
    if (this.currentProcessRssBytes < policy.softProcessRssBytes) return;
    this.admissionPaused = true;
    this.shedPending = true;
    if (reason !== "turn-complete" || this.shedCompleted) return;
    this.currentState = "shedding";
    await this.options.releaseTransientResources();
    this.shedCompleted = true;
  }

  workerHeapReported(generation: number, usedBytes: number, limitBytes: number): void {
    if (generation !== this.currentGeneration) return;
    this.workerHeapUsedBytes = usedBytes;
    this.workerHeapLimitBytes = limitBytes;
  }

  async workerExited(exit: import("./daemon-navigation-worker.js").DaemonNavigationWorkerExit) {
    if (exit.generation !== this.currentGeneration || this.currentState === "stopped") return;
    await this.replace();
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

  private replace(): Promise<void> {
    if (this.replacementOperation !== undefined) return this.replacementOperation;
    const cutoff = this.now() - DAEMON_RESOURCE_RESTART_WINDOW_MS;
    this.replacementTimes = this.replacementTimes.filter((replacedAt) => replacedAt > cutoff);
    if (this.replacementTimes.length >= DAEMON_RESOURCE_RESTART_LIMIT) {
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
      .replaceWorker()
      .then((generation) => {
        this.currentGeneration = generation;
        this.workerHeapUsedBytes = undefined;
        this.workerHeapLimitBytes = undefined;
        this.replacementCount += 1;
        this.replacementTimes.push(this.now());
        this.shedPending = false;
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
}

export function daemonMemoryCapBytes(totalMemoryBytes: number): number {
  return DaemonResourcePolicy.fromSystemMemory(totalMemoryBytes).record.hardProcessRssBytes;
}

export interface DaemonResourceMonitorOptions {
  readonly memoryCapBytes: number;
  readonly intervalMs?: number;
  readonly residentMemoryBytes?: () => number;
  readonly onExceeded: () => Promise<void>;
}

export class DaemonResourceMonitor {
  private readonly intervalMs: number;
  private readonly residentMemoryBytes: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private exceeded = false;

  constructor(private readonly options: DaemonResourceMonitorOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.residentMemoryBytes = options.residentMemoryBytes ?? (() => process.memoryUsage().rss);
  }

  start(): void {
    if (this.timer !== undefined || this.exceeded) return;
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref?.();
  }

  async check(): Promise<void> {
    if (this.exceeded || this.residentMemoryBytes() <= this.options.memoryCapBytes) return;
    this.exceeded = true;
    this.stop();
    await this.options.onExceeded();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
