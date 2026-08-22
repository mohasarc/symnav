import type { DaemonRecord } from "./daemon-protocol.js";
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

export class DaemonRegistry {
  constructor(private readonly _registryDirectory: string) {}

  read(_identity: DaemonWorkspaceIdentity): DaemonRecord | undefined {
    throw new Error("Daemon registry reads are not implemented");
  }

  readInstance(
    _identity: DaemonWorkspaceIdentity,
    _instanceId: string,
  ): DaemonRecord | undefined {
    throw new Error("Daemon registry reads are not implemented");
  }

  readStored(_identity: DaemonWorkspaceIdentity): DaemonRecord | undefined {
    throw new Error("Daemon registry reads are not implemented");
  }

  readStoredInstance(
    _identity: DaemonWorkspaceIdentity,
    _instanceId: string,
  ): DaemonRecord | undefined {
    throw new Error("Daemon registry reads are not implemented");
  }

  write(_record: DaemonRecord): void {
    throw new Error("Daemon registry writes are not implemented");
  }

  writeIfStartupOwner(_identity: DaemonWorkspaceIdentity, _record: DaemonRecord): boolean {
    throw new Error("Daemon readiness publication is not implemented");
  }

  acquireStartup(
    _identity: DaemonWorkspaceIdentity,
    _instanceId: string,
  ): StartupLease | undefined {
    throw new Error("Daemon startup election is not implemented");
  }

  startupOwner(_identity: DaemonWorkspaceIdentity): StartupOwner | undefined {
    throw new Error("Daemon startup election is not implemented");
  }

  isStartupOwner(_identity: DaemonWorkspaceIdentity, _instanceId: string): boolean {
    throw new Error("Daemon startup election is not implemented");
  }

  removeStartupLockIfInstance(
    _identity: DaemonWorkspaceIdentity,
    _instanceId: string,
  ): boolean {
    throw new Error("Daemon startup cleanup is not implemented");
  }

  removeIfInstance(_identity: DaemonWorkspaceIdentity, _instanceId: string): void {
    throw new Error("Daemon record removal is not implemented");
  }

  list(): readonly DaemonRecord[] {
    throw new Error("Daemon registry reads are not implemented");
  }
}
