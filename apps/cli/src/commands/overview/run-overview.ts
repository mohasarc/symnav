import { isAbsolute, resolve } from "node:path";
import type { BackendRouter, FileSymbols, Workspace } from "@symnav/core";
import {
  FileNotFoundError,
  IgnoredFileError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "@symnav/core";

export interface RunOverviewArgs {
  workspace: Workspace;
  router: BackendRouter;
  cwd: string;
  inputPath: string;
}

export async function runOverview(args: RunOverviewArgs): Promise<FileSymbols> {
  const { workspace, router, cwd, inputPath } = args;
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
  if (!(await workspace.fs.exists(absolutePath))) {
    throw new FileNotFoundError();
  }
  if (!workspace.isInWorkspace(absolutePath)) {
    throw new OutsideWorkspaceError();
  }
  const relativePath = workspace.toRelative(absolutePath);
  if (workspace.isIgnored(relativePath)) {
    throw new IgnoredFileError();
  }
  const backend = router.find(relativePath);
  if (backend === undefined) {
    throw new UnsupportedFileError();
  }
  return backend.fileSymbols(relativePath);
}
