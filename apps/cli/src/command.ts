import {
  BackendRouter,
  createWorkspace,
  UnsupportedFileError,
  UserFacingError,
  type LanguageBackend,
  type ResolvedPath,
  type Workspace,
} from "@symnav/core";
import type { ProgramContext } from "./program-context.js";
import type { ProgramDependencies } from "./program-dependencies.js";

export interface CommandArgs {
  file: string;
}

export interface CommandContext<Args extends CommandArgs = CommandArgs> {
  workspace: Workspace;
  router: BackendRouter;
  cwd: string;
  args: Args;
  path: ResolvedPath;
  backend: LanguageBackend;
}

export interface CommandInvocation<Args extends CommandArgs = CommandArgs> {
  context: ProgramContext;
  dependencies: ProgramDependencies;
  cwdOverride: string | undefined;
  json: boolean;
  args: Args;
}

export interface Command<Result, Args extends CommandArgs = CommandArgs> {
  compute(ctx: CommandContext<Args>): Promise<Result>;
  renderText(result: Result): string;
  renderJson(result: Result): string;
}

export async function runCommand<Result, Args extends CommandArgs>(
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
    const path = await workspace.resolveInputPath(args.file, cwd);
    const backend = router.find(path.relative);
    if (backend === undefined) {
      throw new UnsupportedFileError(args.file);
    }
    result = await command.compute({ workspace, router, cwd, args, path, backend });
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
