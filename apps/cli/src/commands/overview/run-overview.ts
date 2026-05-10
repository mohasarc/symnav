import type { BackendRouter, FileSymbols, Workspace } from "@symnav/core";
import { resolveInputPath } from "./resolve-input-path.js";

export interface RunOverviewArgs {
  workspace: Workspace;
  router: BackendRouter;
  cwd: string;
  inputPath: string;
}

export async function runOverview(args: RunOverviewArgs): Promise<FileSymbols> {
  const absolutePath = resolveInputPath({ cwd: args.cwd, inputPath: args.inputPath });
  const relativePath = args.workspace.toRelative(absolutePath);
  const backend = args.router.find(relativePath);
  if (backend === undefined) {
    throw new Error(`No backend accepts ${relativePath}`);
  }
  return backend.fileSymbols(relativePath);
}
