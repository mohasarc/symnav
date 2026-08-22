import { closeSync, openSync } from "node:fs";
import { totalmem } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

const MEBIBYTE = 1024 * 1024;
const MINIMUM_MEMORY_CAP_BYTES = 256 * MEBIBYTE;
const MAXIMUM_MEMORY_CAP_BYTES = 4 * 1024 * MEBIBYTE;

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

export class NodeDaemonProcessLauncher implements DaemonProcessLauncher {
  readonly memoryCapBytes: number;
  private readonly terminator: DaemonProcessTerminator;

  constructor(
    readonly symnavVersion: string,
    memoryCapBytes = NodeDaemonProcessLauncher.defaultMemoryCapBytes(),
    terminator: DaemonProcessTerminator = new NodeDaemonProcessTerminator(),
  ) {
    this.memoryCapBytes = memoryCapBytes;
    this.terminator = terminator;
  }

  launch(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    processToken: string,
  ): Promise<DaemonProcess> {
    const configuration: DaemonProcessConfiguration = {
      workspaceRoot: identity.workspaceRoot,
      stateDir: dirname(identity.registryDirectory),
      workspaceKey: identity.workspaceKey,
      instanceId,
      processToken,
      endpoint: identity.endpoint(instanceId),
      symnavVersion: this.symnavVersion,
      memoryCapBytes: this.memoryCapBytes,
    };
    const encodedConfiguration = Buffer.from(JSON.stringify(configuration)).toString("base64url");
    const daemonEntryPath = fileURLToPath(new URL("./daemon-entry.js", import.meta.url));
    const logDescriptor = openSync(identity.logPath, "a", 0o600);

    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          `--max-old-space-size=${Math.floor(this.memoryCapBytes / MEBIBYTE)}`,
          daemonEntryPath,
          encodedConfiguration,
        ],
        {
          detached: true,
          stdio: ["ignore", logDescriptor, logDescriptor],
          env: process.env,
        },
      );
      child.once("error", (error) => {
        closeSync(logDescriptor);
        reject(error);
      });
      child.once("spawn", () => {
        closeSync(logDescriptor);
        child.unref();
        resolve(new SpawnedDaemonProcess(child.pid!, this.terminator));
      });
    });
  }

  private static defaultMemoryCapBytes(): number {
    return Math.max(
      MINIMUM_MEMORY_CAP_BYTES,
      Math.min(MAXIMUM_MEMORY_CAP_BYTES, Math.floor(totalmem() / 4)),
    );
  }
}

export class DaemonProcessConfigurationParser {
  static parse(encoded: string | undefined): DaemonProcessConfiguration {
    if (encoded === undefined) throw new Error("Missing daemon process configuration");
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!DaemonProcessConfigurationParser.isConfiguration(value)) {
      throw new Error("Invalid daemon process configuration");
    }
    return value;
  }

  private static isConfiguration(value: unknown): value is DaemonProcessConfiguration {
    if (typeof value !== "object" || value === null) return false;
    const configuration = value as Record<string, unknown>;
    return (
      typeof configuration.workspaceRoot === "string" &&
      typeof configuration.stateDir === "string" &&
      typeof configuration.workspaceKey === "string" &&
      typeof configuration.instanceId === "string" &&
      typeof configuration.processToken === "string" &&
      typeof configuration.endpoint === "string" &&
      typeof configuration.symnavVersion === "string" &&
      typeof configuration.memoryCapBytes === "number"
    );
  }
}
