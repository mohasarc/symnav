import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

interface DaemonProcessConfiguration {
  readonly workspaceRoot: string;
  readonly stateDir: string;
  readonly workspaceKey: string;
  readonly instanceId: string;
  readonly processToken: string;
  readonly endpoint: string;
  readonly symnavVersion: string;
  readonly memoryCapBytes: number;
}

export interface DaemonProcess {
  readonly pid: number;
  terminate(): Promise<void>;
}

export interface DaemonProcessTerminator {
  isAlive(pid: number): boolean;
  terminate(pid: number): Promise<void>;
}

export interface DaemonProcessLauncher {
  readonly symnavVersion: string;
  readonly memoryCapBytes: number;
  launch(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    processToken: string,
  ): Promise<DaemonProcess>;
}

export class DaemonProcessTerminationError extends Error {}
