import { BackendRouter, createWorkspace, UserFacingError, type Workspace } from "@symnav/core";
import type { ArgShape, Outcome } from "@symnav/telemetry";
import type { ProgramContext } from "./program-context.js";
import type { ProgramDependencies } from "./program-dependencies.js";

export interface CommandContext<Args> {
  readonly workspace: Workspace;
  readonly router: BackendRouter;
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

export interface Command<Result, Args> {
  readonly name: string;
  describeArgs(args: Args): ArgShape;
  countResults(result: Result): Record<string, number>;
  compute(ctx: CommandContext<Args>): Promise<Result>;
  renderText(result: Result): string;
  renderJson(result: Result): string;
}

export async function runCommand<Result, Args>(
  command: Command<Result, Args>,
  invocation: CommandInvocation<Args>,
): Promise<void> {
  const { context, dependencies, cwdOverride, json, args } = invocation;
  const cwd = cwdOverride ?? context.cwd;
  const fs = dependencies.fs;
  const telemetryStartedAt = dependencies.telemetryEnabled ? dependencies.clock.now() : undefined;
  let workspace: Workspace | undefined;
  let result: Result | undefined;
  let error: unknown;
  let failed = false;
  let outcome: Outcome = "success";
  let errorReason: string | undefined;

  try {
    workspace = await createWorkspace({ startDir: cwd, fs });
    const router = new BackendRouter(dependencies.backends());
    result = await command.compute({ workspace, router, cwd, args });
  } catch (err) {
    failed = true;
    error = err;
    if (err instanceof UserFacingError) {
      outcome = "user_error";
      errorReason = err.constructor.name;
    } else {
      outcome = "crash";
      errorReason = "crash";
    }
  }

  if (dependencies.telemetryEnabled) {
    recordTelemetry(command, dependencies, {
      cwd,
      workspaceRoot: workspace?.root,
      timestamp: telemetryStartedAt!,
      outcome,
      errorReason,
      result: failed ? undefined : result,
      args,
      json,
    });
  }

  if (failed) {
    handleError(context, error);
    return;
  }

  const rendered = json
    ? command.renderJson(result as Result)
    : command.renderText(result as Result);
  context.stdout.write(rendered);
}

function recordTelemetry<Result, Args>(
  command: Command<Result, Args>,
  dependencies: ProgramDependencies,
  input: {
    readonly cwd: string;
    readonly workspaceRoot: string | undefined;
    readonly timestamp: number;
    readonly outcome: Outcome;
    readonly errorReason: string | undefined;
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
    dependencies.recorder.record({
      symnavVersion: dependencies.symnavVersion,
      command: command.name,
      timestamp: input.timestamp,
      durationMs,
      outcome: input.outcome,
      ...(input.errorReason === undefined ? {} : { errorReason: input.errorReason }),
      argShape: argShapeFor(command.describeArgs(input.args), input.json),
      ...(input.outcome === "success" ? { resultCounts: command.countResults(input.result!) } : {}),
      workspaceId: identity.workspaceId,
      machineId: identity.machineId,
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

function handleError(context: ProgramContext, err: unknown): void {
  if (err instanceof UserFacingError) {
    context.stderr.write(`Cannot answer: ${err.reason}.\n`);
    context.exit(1);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  context.stderr.write(`${message}\n`);
  context.exit(2);
}
