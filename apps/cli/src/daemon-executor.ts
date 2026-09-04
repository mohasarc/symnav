import { performance } from "node:perf_hooks";
import { WorkspaceSession, type BackendRefreshSummary } from "@symnav/core";
import {
  DaemonPolicy,
  type DaemonDiagnostics,
  type DaemonExecutor,
  type DaemonExecutorExecutionResult,
  type DaemonExecutorFactoryOptions,
  type DaemonExecutorInitializationResult,
  type DaemonExecutorOutput,
  type DaemonExecutorRequest,
  type DaemonExecutorModuleUrl,
  type DaemonOutputRecord,
} from "@symnav/daemon";
import { CliProgramExecutor } from "./cli-program-executor.js";
import type { CommandOutput } from "./command-execution-result.js";
import type { CommandPhaseDurations, ProgramDependencies } from "./program-dependencies.js";
import { createDefaultDependencies } from "./program.js";

class CliDaemonExecutorOutput implements DaemonExecutorOutput {
  private disposal: Promise<void> | undefined;

  constructor(private readonly output: CommandOutput) {}

  async *records(): AsyncIterable<DaemonOutputRecord> {
    for await (const record of this.output.records()) {
      yield { stream: record.stream, bytes: record.bytes };
    }
  }

  dispose(): Promise<void> {
    this.disposal ??= this.output.dispose();
    return this.disposal;
  }
}

class CliDaemonExecutor implements DaemonExecutor {
  private readonly workspaceSession: WorkspaceSession;
  private readonly programExecutor: CliProgramExecutor;
  private initialization: Promise<DaemonExecutorInitializationResult> | undefined;
  private latestRefresh: BackendRefreshSummary = {
    added: 0,
    changed: 0,
    removed: 0,
    unchanged: 0,
  };
  private latestCommandDurations: CommandPhaseDurations = {
    freshnessMs: 0,
    navigationMs: 0,
    renderMs: 0,
  };

  constructor(dependencies: ProgramDependencies, sampleResources: () => void) {
    const backends = dependencies.backends();
    this.workspaceSession = new WorkspaceSession({
      fileSystem: dependencies.fs,
      backends,
      discoveryRetention: "session",
    });
    this.programExecutor = new CliProgramExecutor(
      {
        ...dependencies,
        backends: () => backends,
        backendRefreshed: (refresh) => {
          this.latestRefresh = refresh;
        },
        commandPhasesObserved: (durations) => {
          this.latestCommandDurations = durations;
          sampleResources();
        },
      },
      this.workspaceSession,
    );
  }

  initialize(workspaceRoot: string): Promise<DaemonExecutorInitializationResult> {
    this.initialization ??= this.prepare(workspaceRoot);
    return this.initialization;
  }

  async execute(request: DaemonExecutorRequest): Promise<DaemonExecutorExecutionResult> {
    this.latestCommandDurations = { freshnessMs: 0, navigationMs: 0, renderMs: 0 };
    const result = await this.programExecutor.execute(request);
    return {
      exitCode: result.exitCode,
      output: new CliDaemonExecutorOutput(result.output),
      diagnostics: this.executionDiagnostics(),
    };
  }

  releaseTransientResources(): Promise<void> {
    return this.workspaceSession.releaseTransientResources();
  }

  private async prepare(workspaceRoot: string): Promise<DaemonExecutorInitializationResult> {
    const startedAt = performance.now();
    const prepared = await this.workspaceSession.prepare(workspaceRoot);
    this.latestRefresh = prepared.refresh;
    const indexingMs = Math.max(0, performance.now() - startedAt);
    return {
      fileCount: prepared.refresh.added + prepared.refresh.unchanged,
      diagnostics: {
        refresh: this.refreshDiagnostics(),
        durations: { discoveryMs: 0, indexingMs },
      },
    };
  }

  private executionDiagnostics(): DaemonDiagnostics {
    return {
      refresh: this.refreshDiagnostics(),
      durations: {
        freshnessMs: this.latestCommandDurations.freshnessMs,
        navigationMs: this.latestCommandDurations.navigationMs,
        renderMs: this.latestCommandDurations.renderMs,
      },
    };
  }

  private refreshDiagnostics(): DaemonDiagnostics {
    return {
      added: this.latestRefresh.added,
      changed: this.latestRefresh.changed,
      removed: this.latestRefresh.removed,
      unchanged: this.latestRefresh.unchanged,
    };
  }
}

export function createDaemonExecutor(options: DaemonExecutorFactoryOptions): DaemonExecutor {
  const dependencies = createDefaultDependencies(
    options.stateDirectory,
    DaemonPolicy.currentSystem(),
  );
  if (dependencies.symnavVersion !== options.productVersion) {
    throw new Error("Daemon executor version does not match host product");
  }
  return new CliDaemonExecutor(dependencies, options.sampleResources);
}

export function daemonExecutorModuleUrl(): DaemonExecutorModuleUrl {
  return new URL("./daemon-executor.js", import.meta.url).href;
}
