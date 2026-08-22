import { E2eProcessCleanupError } from "../helpers/e2e-process-cleanup.js";

export interface NavigationModeDaemon {
  readonly workspaceRoot: string;
  readonly pid: number;
}

export interface NavigationModeCleanupDependencies {
  discoverDaemons(): readonly NavigationModeDaemon[];
  stop(daemon: NavigationModeDaemon): void;
  terminate(processIds: readonly number[]): Promise<void>;
  validateRemainingDaemons(): void;
  removeRunRoot(): void;
}

interface NavigationModeCleanupOutcome {
  readonly status: number;
  readonly errors: readonly string[];
}

export class NavigationModeCleanup {
  constructor(private readonly dependencies: NavigationModeCleanupDependencies) {}

  async run(nestedStatus: number): Promise<NavigationModeCleanupOutcome> {
    const errors: string[] = [];
    let daemons: readonly NavigationModeDaemon[] | undefined;
    try {
      daemons = this.dependencies.discoverDaemons();
    } catch (error) {
      errors.push(`Daemon discovery failed: ${NavigationModeCleanup.errorMessage(error)}`);
    }
    if (daemons !== undefined) await this.cleanupDaemons(daemons, errors);
    try {
      this.dependencies.removeRunRoot();
    } catch (error) {
      errors.push(`Run directory removal failed: ${NavigationModeCleanup.errorMessage(error)}`);
    }
    return {
      status: nestedStatus === 0 && errors.length !== 0 ? 1 : nestedStatus,
      errors,
    };
  }

  private async cleanupDaemons(
    daemons: readonly NavigationModeDaemon[],
    errors: string[],
  ): Promise<void> {
    for (const daemon of daemons) {
      try {
        this.dependencies.stop(daemon);
      } catch (error) {
        errors.push(
          `Graceful stop failed for ${daemon.workspaceRoot}: ${NavigationModeCleanup.errorMessage(error)}`,
        );
      }
    }
    try {
      await this.dependencies.terminate(daemons.map((daemon) => daemon.pid));
    } catch (error) {
      errors.push(...NavigationModeCleanup.terminationFailures(error));
    }
    try {
      this.dependencies.validateRemainingDaemons();
    } catch (error) {
      errors.push(
        `Remaining daemon validation failed: ${NavigationModeCleanup.errorMessage(error)}`,
      );
    }
  }

  private static terminationFailures(error: unknown): readonly string[] {
    if (error instanceof E2eProcessCleanupError) return error.failures;
    return [`Daemon termination failed: ${NavigationModeCleanup.errorMessage(error)}`];
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
