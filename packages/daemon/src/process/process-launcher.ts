import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  DaemonPolicy,
  type DaemonExecutorModuleUrl,
  type DaemonPolicyValues,
} from "@symnav/daemon";
import type { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";
import type { DaemonIdentityCoordinates } from "../transport/protocol.js";
import { NodeDaemonClock, type DaemonClock } from "../lifecycle/daemon-clock.js";

interface DaemonProcessConfiguration extends DaemonIdentityCoordinates {
  readonly stateDirectory: string;
  readonly symnavVersion: string;
  readonly executorModuleUrl: DaemonExecutorModuleUrl;
  readonly policy: ReturnType<DaemonPolicy["toSerialized"]>;
  readonly startupOwnerKind: "daemon";
}

export interface DaemonProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cause: "exit" | "spawn-error";
  readonly errorName?: string;
}

export interface DaemonProcess {
  readonly pid: number;
  readonly exited: Promise<DaemonProcessExit>;
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
    readonly exited: Promise<DaemonProcessExit>,
    private readonly terminator: DaemonProcessTerminator,
  ) {}

  terminate(): Promise<void> {
    return this.terminator.terminate(this.pid);
  }
}

export class NodeDaemonProcessTerminator implements DaemonProcessTerminator {
  private readonly gracefulTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    policy: DaemonPolicyValues["shutdown"],
    private readonly clock: Pick<DaemonClock, "wallNowMs"> = new NodeDaemonClock(),
  ) {
    this.gracefulTimeoutMs = policy.processSignalExitTimeoutMs;
    this.pollIntervalMs = policy.processExitPollIntervalMs;
  }

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
    const deadline = this.clock.wallNowMs() + this.gracefulTimeoutMs;
    while (this.clock.wallNowMs() <= deadline) {
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
  private readonly terminator: DaemonProcessTerminator;

  constructor(
    readonly symnavVersion: string,
    readonly executorModuleUrl: DaemonExecutorModuleUrl,
    readonly policy: DaemonPolicy,
    terminator: DaemonProcessTerminator = new NodeDaemonProcessTerminator(policy.values.shutdown),
  ) {
    this.terminator = terminator;
  }

  get memoryCapBytes(): number {
    return this.policy.values.resources.hardProcessRssBytes;
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
      executorModuleUrl: this.executorModuleUrl,
      policy: this.policy.toSerialized(),
      startupOwnerKind: "daemon",
    };
    const encodedConfiguration = Buffer.from(JSON.stringify(configuration)).toString("base64url");
    const daemonEntryPath = fileURLToPath(new URL("./daemon-entry.js", import.meta.url));
    mkdirSync(identity.identityDirectory, { recursive: true, mode: 0o700 });

    return new Promise((resolve, reject) => {
      let processSpawned = false;
      let exitResolved = false;
      let resolveExit: (exit: DaemonProcessExit) => void = () => undefined;
      const exited = new Promise<DaemonProcessExit>((exitResolve) => {
        resolveExit = exitResolve;
      });
      const settleExit = (exit: DaemonProcessExit): void => {
        if (exitResolved) return;
        exitResolved = true;
        resolveExit(exit);
      };
      const child = spawn(process.execPath, [daemonEntryPath, encodedConfiguration], {
        cwd: tmpdir(),
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, SYMNAV_STATE_DIR: stateDirectory },
      });
      child.once("error", (error) => {
        settleExit({
          code: null,
          signal: null,
          cause: "spawn-error",
          errorName: error.name,
        });
        if (!processSpawned) reject(error);
      });
      child.once("spawn", () => {
        processSpawned = true;
        child.unref();
        resolve(new SpawnedDaemonProcess(child.pid!, exited, this.terminator));
      });
      child.once("exit", (code, signal) => {
        settleExit({ code, signal, cause: "exit" });
      });
    });
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
      DaemonProcessConfigurationParser.hasExactKeys(configuration, [
        "workspaceRoot",
        "stateDirectory",
        "workspaceKey",
        "stateKey",
        "identityKey",
        "instanceId",
        "processToken",
        "endpoint",
        "symnavVersion",
        "executorModuleUrl",
        "policy",
        "startupOwnerKind",
      ]) &&
      typeof configuration.workspaceRoot === "string" &&
      typeof configuration.stateDirectory === "string" &&
      typeof configuration.workspaceKey === "string" &&
      typeof configuration.stateKey === "string" &&
      typeof configuration.identityKey === "string" &&
      typeof configuration.instanceId === "string" &&
      typeof configuration.processToken === "string" &&
      typeof configuration.endpoint === "string" &&
      typeof configuration.symnavVersion === "string" &&
      DaemonProcessConfigurationParser.isModuleUrl(configuration.executorModuleUrl) &&
      DaemonProcessConfigurationParser.isPolicy(configuration.policy) &&
      configuration.startupOwnerKind === "daemon"
    );
  }

  private static hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length && actual.every((key, index) => key === expected[index])
    );
  }

  private static isModuleUrl(value: unknown): value is DaemonExecutorModuleUrl {
    if (typeof value !== "string") return false;
    try {
      return new URL(value).href === value;
    } catch {
      return false;
    }
  }

  private static isPolicy(value: unknown): value is ReturnType<DaemonPolicy["toSerialized"]> {
    try {
      DaemonPolicy.fromSerialized(value);
      return true;
    } catch {
      return false;
    }
  }
}
