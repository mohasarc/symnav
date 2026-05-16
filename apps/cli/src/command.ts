import { BackendRouter, createWorkspace, UserFacingError, type Workspace } from "@symnav/core";
import type { ProgramContext } from "./program-context.js";
import type { ProgramDependencies } from "./program-dependencies.js";

export interface CommandContext {
  workspace: Workspace;
  router: BackendRouter;
  cwd: string;
}

export interface CommandInvocation {
  context: ProgramContext;
  dependencies: ProgramDependencies;
  cwdOverride: string | undefined;
  json: boolean;
}

export abstract class Command<Result> {
  abstract compute(ctx: CommandContext): Promise<Result>;
  abstract renderText(result: Result): string;
  abstract renderJson(result: Result): string;
}

export async function runCommand<Result>(
  command: Command<Result>,
  invocation: CommandInvocation,
): Promise<void> {
  const { context, dependencies, cwdOverride, json } = invocation;
  const cwd = cwdOverride ?? context.cwd;
  const fs = dependencies.fs;
  let result: Result;
  try {
    const workspace = await createWorkspace({ startDir: cwd, fs });
    const router = new BackendRouter(dependencies.backends());
    result = await command.compute({ workspace, router, cwd });
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
