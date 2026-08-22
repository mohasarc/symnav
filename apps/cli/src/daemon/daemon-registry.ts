import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

export interface StartupOwner {
  readonly instanceId: string;
  readonly ownerPid: number;
  readonly acquiredAt: number;
}

export interface StartupLease {
  readonly instanceId: string;
  release(): void;
}
