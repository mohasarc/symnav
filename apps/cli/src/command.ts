import {
  BackendRouter,
  createWorkspace,
  NodeFileSystem,
  UserFacingError,
  type Workspace,
} from "@symnav/core";
import { TypeScriptBackend } from "@symnav/backend-typescript";
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
  let result: Result;
  try {
    const workspace = await createWorkspace({
      startDir: cwd,
      fs: dependencies.fs ?? new NodeFileSystem(),
    });
    const backends = dependencies.backends
      ? dependencies.backends(workspace)
      : [new TypeScriptBackend(workspace)];
    const router = new BackendRouter(backends);
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
