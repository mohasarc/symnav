export interface TelemetryWriteFailure {
  readonly path: string;
  readonly osCode?: string;
}

export interface TelemetryFailureObserver {
  writeFailed(failure: TelemetryWriteFailure): void;
}
