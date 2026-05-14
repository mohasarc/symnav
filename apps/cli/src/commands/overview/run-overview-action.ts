import {
  BackendRouter,
  createWorkspace,
  type FileSymbols,
  NodeFileSystem,
  UserFacingError,
  type Workspace,
} from "@symnav/core";
import { TypeScriptBackend } from "@symnav/backend-typescript";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";
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
  const fs = args.dependencies.fs ?? new NodeFileSystem();
  let workspace: Workspace;
  try {
    workspace = await createWorkspace({ startDir: cwd, fs });
  } catch (err) {
    handleError(args.context, err);
    return;
  }
  const backends = args.dependencies.backends
    ? args.dependencies.backends(workspace)
    : [new TypeScriptBackend(workspace, fs)];
  const router = new BackendRouter(backends);
  let symbols: FileSymbols;
  try {
    symbols = await runOverview({ workspace, router, cwd, inputPath: args.file });
  } catch (err) {
    handleError(args.context, err);
    return;
  }
  const rendered = args.json ? renderOverviewJson(symbols) : renderOverviewText(symbols);
  args.context.stdout.write(rendered);
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
