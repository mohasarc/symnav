import {
  BackendRouter,
  FileNotFoundError,
  IgnoredFileError,
  NodeWorkspace,
  NotInWorkspaceError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "@symnav/core";
import { TypeScriptBackend } from "@symnav/backend-typescript";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";
import { formatUserError } from "../../error-output/format-user-error.js";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { runOverview } from "./run-overview.js";

export interface RunOverviewActionArgs {
  context: ProgramContext;
  dependencies: ProgramDependencies;
  file: string;
  json: boolean;
  cwdOverride: string | undefined;
}

export async function runOverviewAction(args: RunOverviewActionArgs): Promise<void> {
  const cwd = args.cwdOverride ?? args.context.cwd;
  let workspace: NodeWorkspace;
  try {
    workspace = await NodeWorkspace.create(
      args.dependencies.fs !== undefined
        ? { startDir: cwd, fs: args.dependencies.fs }
        : { startDir: cwd },
    );
  } catch (err) {
    if (err instanceof NotInWorkspaceError) {
      writeUserError(args.context, formatUserError(err, { cwd }));
      return;
    }
    exitUnexpected(args.context, err);
    return;
  }
  try {
    const backends = args.dependencies.backends
      ? args.dependencies.backends(workspace)
      : [new TypeScriptBackend(workspace)];
    const router = new BackendRouter(backends);
    const symbols = await runOverview({
      workspace,
      router,
      cwd,
      inputPath: args.file,
    });
    const rendered = args.json ? renderOverviewJson(symbols) : renderOverviewText(symbols);
    args.context.stdout.write(rendered);
  } catch (err) {
    const inputPath = args.file;
    const workspaceRoot = workspace.root;
    if (err instanceof FileNotFoundError) {
      writeUserError(args.context, formatUserError(err, { inputPath }));
      return;
    }
    if (err instanceof IgnoredFileError) {
      writeUserError(args.context, formatUserError(err, { inputPath }));
      return;
    }
    if (err instanceof OutsideWorkspaceError) {
      writeUserError(args.context, formatUserError(err, { inputPath, workspaceRoot }));
      return;
    }
    if (err instanceof UnsupportedFileError) {
      writeUserError(args.context, formatUserError(err, { inputPath }));
      return;
    }
    exitUnexpected(args.context, err);
  }
}

function writeUserError(context: ProgramContext, line: string): void {
  context.stderr.write(`${line}\n`);
  context.exit(1);
}

function exitUnexpected(context: ProgramContext, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  context.stderr.write(`${message}\n`);
  context.exit(2);
}
