const MEBIBYTE = 1024 * 1024;
const MINIMUM_MEMORY_CAP_BYTES = 256 * MEBIBYTE;
const MAXIMUM_MEMORY_CAP_BYTES = 4 * 1024 * MEBIBYTE;
const DEFAULT_CHECK_INTERVAL_MS = 5_000;

export function daemonMemoryCapBytes(totalMemoryBytes: number): number {
  return Math.max(
    MINIMUM_MEMORY_CAP_BYTES,
    Math.min(MAXIMUM_MEMORY_CAP_BYTES, Math.floor(totalMemoryBytes / 4)),
  );
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
