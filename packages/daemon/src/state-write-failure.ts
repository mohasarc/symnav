export interface DaemonStateWriteFailure {
  readonly path: string;
  readonly osCode?: string;
}

export type DaemonStateWriteFailureObserver = (failure: DaemonStateWriteFailure) => void;
