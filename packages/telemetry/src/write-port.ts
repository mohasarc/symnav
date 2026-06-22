export interface TelemetryWritePort {
  append(line: string): void;
}
