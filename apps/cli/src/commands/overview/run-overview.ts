import { isAbsolute, resolve } from "node:path";
import type { BackendRouter, FileSystem, FileSymbols, Workspace } from "@symnav/core";
import {
  FileNotFoundError,
  IgnoredFileError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "@symnav/core";

export interface RunOverviewArgs {
  workspace: Workspace;
  fs: FileSystem;
  router: BackendRouter;
  cwd: string;
  inputPath: string;
}

export async function runOverview(args: RunOverviewArgs): Promise<FileSymbols> {
  const { workspace, fs, router, cwd, inputPath } = args;
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
  if (!(await fs.exists(absolutePath))) {
    throw new FileNotFoundError(inputPath);
  }
  if (!workspace.isInWorkspace(absolutePath)) {
    throw new OutsideWorkspaceError(inputPath, workspace.root);
  }
  const relativePath = workspace.toRelative(absolutePath);
  if (workspace.isIgnored(relativePath)) {
    throw new IgnoredFileError(inputPath);
  }
  const backend = router.find(relativePath);
  if (backend === undefined) {
    throw new UnsupportedFileError(inputPath);
  }
  return backend.fileSymbols(relativePath);
}
