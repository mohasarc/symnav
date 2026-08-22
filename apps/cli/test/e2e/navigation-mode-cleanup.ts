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
