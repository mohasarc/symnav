const MEBIBYTE = 1024 * 1024;
const MINIMUM_MEMORY_CAP_BYTES = 256 * MEBIBYTE;
const MAXIMUM_MEMORY_CAP_BYTES = 4 * 1024 * MEBIBYTE;

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
