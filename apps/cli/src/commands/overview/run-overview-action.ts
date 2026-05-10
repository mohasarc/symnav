import { BackendRouter, NodeWorkspace } from "@symnav/core";
import { TypeScriptBackend } from "@symnav/backend-typescript";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { runOverview } from "./run-overview.js";
import { writeOverviewOutput } from "./write-overview-output.js";

export interface RunOverviewActionArgs {
  context: ProgramContext;
  dependencies: ProgramDependencies;
  file: string;
  json: boolean;
  cwdOverride: string | undefined;
}

export async function runOverviewAction(args: RunOverviewActionArgs): Promise<void> {
  const cwd = args.cwdOverride ?? args.context.cwd;
  const workspaceOpts = args.dependencies.fs
    ? { startDir: cwd, fs: args.dependencies.fs }
    : { startDir: cwd };
  const workspace = await NodeWorkspace.create(workspaceOpts);
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
  writeOverviewOutput({
    symbols,
    json: args.json,
    stdout: args.context.stdout,
  });
}
