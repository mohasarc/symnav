import { BackendRouter, createWorkspace, UserFacingError, type Workspace } from "@symnav/core";
import type { ArgShape } from "@symnav/telemetry";
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
  let result: Result;
  try {
    const workspace = await createWorkspace({ startDir: cwd, fs });
    const router = new BackendRouter(dependencies.backends());
    result = await command.compute({ workspace, router, cwd, args });
  } catch (err) {
    handleError(context, err);
    return;
  }
  const rendered = json ? command.renderJson(result) : command.renderText(result);
  context.stdout.write(rendered);
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
