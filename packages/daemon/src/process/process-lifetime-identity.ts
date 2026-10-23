export interface DaemonProcessLifetimeIdentity {
  readonly token: string;
  readonly path: string;
}

export type DaemonProcessLifetimeObservation = "live" | "exited" | "unknown";
