import { closeSync, mkdirSync, openSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { DaemonIdentityCoordinates } from "./daemon-protocol.js";
import { daemonMemoryCapBytes } from "./daemon-resource-monitor.js";

const MEBIBYTE = 1024 * 1024;

interface DaemonProcessConfiguration extends DaemonIdentityCoordinates {
  readonly stateDirectory: string;
  readonly symnavVersion: string;
  readonly memoryCapBytes: number;
}

export interface DaemonProcess {
  readonly pid: number;
  readonly exited: Promise<DaemonProcessExit>;
  terminate(): Promise<void>;
}

export interface DaemonProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cause: "exit" | "spawn-error";
  readonly errorName?: string;
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
    readonly exited: Promise<DaemonProcessExit>,
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
    const stateDirectory = identity.stateDirectory;
    const configuration: DaemonProcessConfiguration = {
      workspaceRoot: identity.workspaceRoot,
      stateDirectory,
      workspaceKey: identity.workspaceKey,
      stateKey: identity.stateKey,
      identityKey: identity.identityKey,
      instanceId,
      processToken,
      endpoint: identity.endpoint(instanceId),
      symnavVersion: this.symnavVersion,
      memoryCapBytes: this.memoryCapBytes,
    };
    const encodedConfiguration = Buffer.from(JSON.stringify(configuration)).toString("base64url");
    const daemonEntryPath = fileURLToPath(new URL("./daemon-entry.js", import.meta.url));
    mkdirSync(identity.identityDirectory, { recursive: true, mode: 0o700 });
    const logDescriptor = openSync(identity.logPath, "a", 0o600);

    return new Promise((resolve, reject) => {
      let processSpawned = false;
      let logClosed = false;
      let exitResolved = false;
      let resolveExit: (exit: DaemonProcessExit) => void = () => undefined;
      const exited = new Promise<DaemonProcessExit>((exitResolve) => {
        resolveExit = exitResolve;
      });
      const closeLog = (): void => {
        if (logClosed) return;
        logClosed = true;
        closeSync(logDescriptor);
      };
      const publishExit = (exit: DaemonProcessExit): void => {
        if (exitResolved) return;
        exitResolved = true;
        resolveExit(exit);
      };
      const child = spawn(
        process.execPath,
        [
          `--max-old-space-size=${Math.floor(this.memoryCapBytes / MEBIBYTE)}`,
          daemonEntryPath,
          encodedConfiguration,
        ],
        {
          cwd: tmpdir(),
          detached: true,
          stdio: ["ignore", logDescriptor, logDescriptor],
          env: { ...process.env, SYMNAV_STATE_DIR: stateDirectory },
        },
      );
      child.once("error", (error) => {
        closeLog();
        publishExit({ code: null, signal: null, cause: "spawn-error", errorName: error.name });
        if (!processSpawned) reject(error);
      });
      child.once("spawn", () => {
        processSpawned = true;
        closeLog();
        child.unref();
        resolve(new SpawnedDaemonProcess(child.pid!, exited, this.terminator));
      });
      child.once("exit", (code, signal) => {
        publishExit({ code, signal, cause: "exit" });
      });
    });
  }

  private static defaultMemoryCapBytes(): number {
    return daemonMemoryCapBytes(totalmem());
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
      typeof configuration.stateDirectory === "string" &&
      typeof configuration.workspaceKey === "string" &&
      typeof configuration.stateKey === "string" &&
      typeof configuration.identityKey === "string" &&
      typeof configuration.instanceId === "string" &&
      typeof configuration.processToken === "string" &&
      typeof configuration.endpoint === "string" &&
      typeof configuration.symnavVersion === "string" &&
      typeof configuration.memoryCapBytes === "number"
    );
  }
}
