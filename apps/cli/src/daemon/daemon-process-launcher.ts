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

class SpawnedDaemonProcess implements DaemonProcess {
  constructor(
    readonly pid: number,
    private readonly terminator: DaemonProcessTerminator,
  ) {}

  terminate(): Promise<void> {
    return this.terminator.terminate(this.pid);
  }
}

export class NodeDaemonProcessTerminator implements DaemonProcessTerminator {
  constructor(
    private readonly gracefulTimeoutMs = 500,
    private readonly pollIntervalMs = 20,
  ) {}

  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return NodeDaemonProcessTerminator.errorCode(error) === "EPERM";
    }
  }

  async terminate(pid: number): Promise<void> {
    if (!this.isAlive(pid)) return;
    if (pid === process.pid) throw new Error("Refusing to terminate current process");
    this.signal(pid, "SIGTERM");
    if (await this.waitForExit(pid)) return;
    this.signal(pid, "SIGKILL");
    if (await this.waitForExit(pid)) return;
    throw new DaemonProcessTerminationError(`Daemon process ${pid} did not terminate`);
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (NodeDaemonProcessTerminator.errorCode(error) !== "ESRCH") throw error;
    }
  }

  private async waitForExit(pid: number): Promise<boolean> {
    const deadline = Date.now() + this.gracefulTimeoutMs;
    while (Date.now() <= deadline) {
      if (!this.isAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    return !this.isAlive(pid);
  }

  private static errorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    return (error as { readonly code?: string }).code;
  }
}
