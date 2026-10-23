import type { DaemonProcessLifetimeIdentity } from "../process/process-lifetime-identity.js";

export interface FileDaemonOwner {
  readonly token: string;
  readonly pid: number;
  readonly processLifetime: DaemonProcessLifetimeIdentity;
}

export interface FileDaemonEndpointOwner extends FileDaemonOwner {
  readonly directory: string;
}
