import type { BackendRouter, FileSymbols, Workspace } from "@symnav/core";
import { UnsupportedFileError } from "@symnav/core";

export interface RunOverviewArgs {
  workspace: Workspace;
  router: BackendRouter;
  cwd: string;
  inputPath: string;
}

export async function runOverview(args: RunOverviewArgs): Promise<FileSymbols> {
  const { workspace, router, cwd, inputPath } = args;
  const relativePath = await workspace.resolveInputPath(inputPath, cwd);
  const backend = router.find(relativePath);
  if (backend === undefined) {
    throw new UnsupportedFileError(inputPath);
  }
  return backend.fileSymbols(relativePath);
}
