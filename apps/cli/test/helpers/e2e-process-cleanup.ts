import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import {
  type DaemonProcessTerminator,
  NodeDaemonProcessTerminator,
} from "../../src/daemon/daemon-process-launcher.js";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "./local-daemon-transport.js";

export class E2eProcessCleanupError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(failures.join("\n"));
  }
}

interface TerminateAndRemoveDirectoriesOptions {
  readonly children?: readonly ChildProcess[];
  readonly processTerminator?: DaemonProcessTerminator;
  readonly removeDirectory?: typeof rmSync;
  readonly retryTimeoutMs?: number;
  readonly retryDelayMs?: number;
}

export class E2eProcessCleanup {
  static async terminate(
    daemonProcessIds: readonly number[],
    children: readonly ChildProcess[] = [],
    processTerminator: DaemonProcessTerminator = new NodeDaemonProcessTerminator(1_000, 10),
  ): Promise<void> {
    const childExitFailures = children.map((child) => E2eProcessCleanup.childExitFailure(child));
    const processProvenance = new Map<number, "daemon" | "helper">();
    for (const processId of daemonProcessIds) processProvenance.set(processId, "daemon");
    for (const child of children) {
      if (child.pid !== undefined && !processProvenance.has(child.pid)) {
        processProvenance.set(child.pid, "helper");
      }
    }
    const failures: string[] = [];
    for (const [processId, provenance] of processProvenance) {
      try {
        await processTerminator.terminate(processId);
      } catch (error) {
        const processKind = provenance === "daemon" ? "Daemon" : "Helper";
        failures.push(
          `${processKind} process ${processId} termination failed: ${E2eProcessCleanup.errorMessage(error)}`,
        );
      }
    }
    failures.push(
      ...(await Promise.all(childExitFailures)).flatMap((failure) =>
        failure === undefined ? [] : [failure],
      ),
    );
    if (failures.length !== 0) throw new E2eProcessCleanupError(failures);
  }

  static async waitForExit(processIds: readonly number[]): Promise<void> {
    const terminator = new NodeDaemonProcessTerminator();
    const deadline = Date.now() + 1_000;
    while (Date.now() <= deadline) {
      if (processIds.every((processId) => !terminator.isAlive(processId))) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const runningProcessIds = processIds.filter((processId) => terminator.isAlive(processId));
    if (runningProcessIds.length !== 0) {
      throw new Error(`Processes did not exit: ${runningProcessIds.join(", ")}`);
    }
  }

  static async kill(processIds: readonly number[]): Promise<void> {
    for (const processId of processIds) {
      try {
        process.kill(processId, "SIGKILL");
      } catch (error) {
        if (E2eProcessCleanup.errorCode(error) !== "ESRCH") throw error;
      }
    }
    await E2eProcessCleanup.waitForExit(processIds);
  }

  static async waitForEndpointRelease(endpoint: string): Promise<void> {
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 100 });
    const deadline = Date.now() + 1_000;
    while (Date.now() <= deadline) {
      if (await transport.removeUnavailableEndpoint(endpoint)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Daemon endpoint did not release: ${endpoint}`);
  }

  static removeDirectories(
    directories: readonly string[],
    removeDirectory: typeof rmSync = rmSync,
  ): void {
    for (const directory of directories) {
      removeDirectory(directory, {
        recursive: true,
        force: true,
        maxRetries: 30,
        retryDelay: 100,
      });
    }
  }

  static async terminateAndRemoveDirectories(
    directories: readonly string[],
    daemonProcessIds: () => readonly number[],
    options: TerminateAndRemoveDirectoriesOptions = {},
  ): Promise<void> {
    const processTerminator =
      options.processTerminator ?? new NodeDaemonProcessTerminator(1_000, 10);
    const removeDirectory = options.removeDirectory ?? rmSync;
    const deadline = Date.now() + (options.retryTimeoutMs ?? 5_000);
    let children = options.children ?? [];
    while (true) {
      await E2eProcessCleanup.terminate(daemonProcessIds(), children, processTerminator);
      children = [];
      try {
        E2eProcessCleanup.removeDirectories(directories, removeDirectory);
        return;
      } catch (error) {
        if (!E2eProcessCleanup.directoryRemovalCanRetry(error) || Date.now() >= deadline) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 10));
      }
    }
  }

  private static waitForChildExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Child process ${String(child.pid)} did not exit`)),
        3_000,
      );
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private static async childExitFailure(child: ChildProcess): Promise<string | undefined> {
    try {
      await E2eProcessCleanup.waitForChildExit(child);
      return undefined;
    } catch (error) {
      return `Child process ${String(child.pid)} exit wait failed: ${E2eProcessCleanup.errorMessage(error)}`;
    }
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private static directoryRemovalCanRetry(error: unknown): boolean {
    return ["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"].includes(
      E2eProcessCleanup.errorCode(error) ?? "",
    );
  }

  private static errorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    return (error as { readonly code?: string }).code;
  }
}
