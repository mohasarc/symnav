export interface DaemonResourceMonitorOptions {
  readonly memoryCapBytes: number;
  readonly intervalMs?: number;
  readonly residentMemoryBytes?: () => number;
  readonly onExceeded: () => Promise<void>;
}
