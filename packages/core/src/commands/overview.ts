import { resolve as pathResolve, isAbsolute, extname } from "node:path";
import type { BackendRouter } from "../backend.js";
import {
  FileNotFoundError,
  IgnoredFileError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "../errors.js";
import type { FileSymbols } from "../ir.js";
import type { Workspace } from "../workspace.js";

export interface RunOverviewArgs {
  workspace: Workspace;
  router: BackendRouter;
  cwd: string;
  inputPath: string;
}

export async function runOverview(args: RunOverviewArgs): Promise<FileSymbols> {
  const { workspace, router, cwd, inputPath } = args;
  const absPath = isAbsolute(inputPath)
    ? toPosix(pathResolve(inputPath))
    : toPosix(pathResolve(cwd, inputPath));
  const displayedPath = inputPath;

  if (!(await workspace.fs.exists(absPath))) {
    throw new FileNotFoundError(displayedPath);
  }

  if (!workspace.isInWorkspace(absPath)) {
    throw new OutsideWorkspaceError(displayedPath, workspace.root);
  }

  const relPath = workspace.toRelative(absPath);

  if (workspace.isIgnored(relPath)) {
    throw new IgnoredFileError(displayedPath);
  }

  const backend = router.find(relPath);
  if (!backend) {
    throw new UnsupportedFileError(displayedPath, extname(relPath));
  }

  return backend.fileSymbols(relPath);
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
