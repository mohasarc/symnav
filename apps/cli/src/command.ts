import {
  BackendRouter,
  createWorkspace,
  type GitHistory,
  type NavigationDiagnosticSeverity,
  type ResultWithDiagnostics,
  UserFacingError,
  type Workspace,
  type WorkspaceSnapshot,
} from "@symnav/core";

const severityPrefixes: Record<NavigationDiagnosticSeverity, string> = {
  warning: "Warning",
};
import type { ArgShape, OutcomeReport } from "@symnav/telemetry";
import type { ProgramContext } from "./program-context.js";
import type { ProgramDependencies } from "./program-dependencies.js";

export interface CommandContext<Args> {
  readonly workspace: Workspace;
  readonly router: BackendRouter;
  readonly git: GitHistory;
  readonly cwd: string;
  readonly args: Args;
}

export interface CommandInvocation<Args> {
  context: ProgramContext;
  dependencies: ProgramDependencies;
  cwdOverride: string | undefined;
  json: boolean;
  args: Args;
}

export interface Command<Result extends ResultWithDiagnostics, Args> {
  readonly name: string;
  validate?(args: Args): void;
  snapshotForBackendRefresh?(ctx: CommandContext<Args>): Promise<WorkspaceSnapshot>;
  describeArgs(args: Args): ArgShape;
  countResults(result: Result): Record<string, number>;
  compute(ctx: CommandContext<Args>): Promise<Result>;
  renderText(result: Result): string;
  renderJson(result: Result): string;
  renderError?(err: unknown): string | undefined;
}

export async function runCommand<Result extends ResultWithDiagnostics, Args>(
  command: Command<Result, Args>,
  invocation: CommandInvocation<Args>,
): Promise<void> {
  const { context, dependencies, cwdOverride, json, args } = invocation;
  const cwd = cwdOverride ?? context.cwd;
  const fs = dependencies.fs;
  const telemetryStartedAt = dependencies.telemetryEnabled ? dependencies.clock.now() : undefined;
  let workspace: Workspace | undefined;

  try {
    workspace = await createWorkspace({ startDir: cwd, fs });
    command.validate?.(args);
    const router = new BackendRouter(dependencies.backends());
    const commandContext: CommandContext<Args> = {
      workspace,
      router,
      git: dependencies.git,
      cwd,
      args,
    };
    const snapshot = command.snapshotForBackendRefresh
      ? await command.snapshotForBackendRefresh(commandContext)
      : await workspace.snapshot();
    await router.refresh(snapshot);
    const result = await command.compute(commandContext);
    const rendered = json ? command.renderJson(result) : command.renderText(result);
    for (const diagnostic of result.diagnostics ?? []) {
      context.stderr.write(`${severityPrefixes[diagnostic.severity]}: ${diagnostic.message}\n`);
    }
    context.stdout.write(rendered);

    if (dependencies.telemetryEnabled) {
      recordTelemetry(command, dependencies, {
        cwd,
        workspaceRoot: workspace.root,
        timestamp: telemetryStartedAt!,
        outcomeReport: { outcome: "success" },
        result,
        args,
        json,
      });
    }
  } catch (err) {
    const outcomeReport: OutcomeReport =
      err instanceof UserFacingError
        ? { outcome: "user_error", errorReason: err.constructor.name }
        : { outcome: "crash", errorReason: "crash" };

    if (dependencies.telemetryEnabled) {
      recordTelemetry(command, dependencies, {
        cwd,
        workspaceRoot: workspace?.root,
        timestamp: telemetryStartedAt!,
        outcomeReport,
        result: undefined,
        args,
        json,
      });
    }

    handleError(context, command, err);
  }
}

function recordTelemetry<Result extends ResultWithDiagnostics, Args>(
  command: Command<Result, Args>,
  dependencies: ProgramDependencies,
  input: {
    readonly cwd: string;
    readonly workspaceRoot: string | undefined;
    readonly timestamp: number;
    readonly outcomeReport: OutcomeReport;
    readonly result: Result | undefined;
    readonly args: Args;
    readonly json: boolean;
  },
): void {
  try {
    const durationMs = dependencies.clock.now() - input.timestamp;
    const identity = dependencies.identity.resolve({
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot,
    });
    const argShape = argShapeFor(command.describeArgs(input.args), input.json);

    if (input.outcomeReport.outcome === "success") {
      dependencies.recorder.record({
        symnavVersion: dependencies.symnavVersion,
        command: command.name,
        timestamp: input.timestamp,
        durationMs,
        outcome: "success",
        argShape,
        resultCounts: command.countResults(input.result!),
        workspaceId: identity.workspaceId,
        machineId: identity.machineId,
      });
      return;
    }

    dependencies.recorder.record({
      symnavVersion: dependencies.symnavVersion,
      command: command.name,
      timestamp: input.timestamp,
      durationMs,
      argShape,
      workspaceId: identity.workspaceId,
      machineId: identity.machineId,
      ...input.outcomeReport,
    });
  } catch {
    return;
  }
}

function argShapeFor(shape: ArgShape, json: boolean): ArgShape {
  const flags = json ? Array.from(new Set([...shape.flags, "json"])) : [...shape.flags];
  flags.sort();
  return { ...shape, flags };
}

function handleError<Result extends ResultWithDiagnostics, Args>(
  context: ProgramContext,
  command: Command<Result, Args>,
  err: unknown,
): void {
  if (err instanceof UserFacingError) {
    context.stderr.write(command.renderError?.(err) ?? err.render());
    context.exit(1);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  context.stderr.write(`${message}\n`);
  context.exit(2);
}
