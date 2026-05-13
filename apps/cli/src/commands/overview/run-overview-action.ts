import { BackendError, BackendRouter, NodeWorkspace, NotInWorkspaceError } from "@symnav/core";
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
    exitWithError(err, args.context, { cwd });
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
    exitWithError(err, args.context, {
      inputPath: args.file,
      workspaceRoot: workspace.root,
    });
  }
}

function exitWithError(
  err: unknown,
  context: ProgramContext,
  formatContext: Parameters<typeof formatUserError>[1],
): void {
  if (err instanceof BackendError || err instanceof NotInWorkspaceError) {
    const line = formatUserError(err, formatContext);
    if (line !== null) {
      context.stderr.write(`${line}\n`);
      context.exit(1);
      return;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  context.stderr.write(`${message}\n`);
  context.exit(2);
}
