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
