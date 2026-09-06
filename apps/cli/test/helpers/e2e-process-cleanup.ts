import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

export interface TestProcessTerminator {
  isAlive(processId: number): boolean;
  terminate(processId: number): Promise<void>;
}

class NodeTestProcessTerminator implements TestProcessTerminator {
  constructor(
    private readonly signalExitTimeoutMs = 1_000,
    private readonly exitPollIntervalMs = 10,
  ) {}

  isAlive(processId: number): boolean {
    if (!Number.isInteger(processId) || processId <= 0) return false;
    try {
      process.kill(processId, 0);
      return true;
    } catch (error) {
      return NodeTestProcessTerminator.errorCode(error) === "EPERM";
    }
  }

  async terminate(processId: number): Promise<void> {
    if (!this.isAlive(processId)) return;
    if (processId === process.pid) throw new Error("Refusing to terminate current process");
    this.signal(processId, "SIGTERM");
    if (await this.waitForExit(processId)) return;
    this.signal(processId, "SIGKILL");
    if (await this.waitForExit(processId)) return;
    throw new Error(`Process ${processId} did not terminate`);
  }

  private signal(processId: number, signal: NodeJS.Signals): void {
    try {
      process.kill(processId, signal);
    } catch (error) {
      if (NodeTestProcessTerminator.errorCode(error) !== "ESRCH") throw error;
    }
  }

  private async waitForExit(processId: number): Promise<boolean> {
    const deadline = Date.now() + this.signalExitTimeoutMs;
    while (Date.now() <= deadline) {
      if (!this.isAlive(processId)) return true;
      await new Promise((resolve) => setTimeout(resolve, this.exitPollIntervalMs));
    }
    return !this.isAlive(processId);
  }

  private static errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
  }
}

export class E2eProcessCleanupError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(failures.join("\n"));
  }
}

interface TerminateAndRemoveDirectoriesOptions {
  readonly children?: readonly ChildProcess[];
  readonly processTerminator?: TestProcessTerminator;
  readonly removeDirectory?: typeof rmSync;
  readonly retryTimeoutMs?: number;
  readonly retryDelayMs?: number;
}

export class E2eProcessCleanup {
  static async terminate(
    daemonProcessIds: readonly number[],
    children: readonly ChildProcess[] = [],
    processTerminator: TestProcessTerminator = new NodeTestProcessTerminator(),
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
    const terminator = new NodeTestProcessTerminator();
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
    const processTerminator = options.processTerminator ?? new NodeTestProcessTerminator();
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
