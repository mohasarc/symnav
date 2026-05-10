import { posix } from "node:path";
import type { BackendRouter } from "../backend/backend-router.js";
import {
  FileNotFoundError,
  IgnoredFileError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "../backend/errors.js";
import type { FileSymbols } from "../intermediate-representation/types.js";
import type { Workspace } from "../workspace/workspace.js";

/**
 * Inputs to `runOverview`. The caller supplies a built `Workspace` and
 * `BackendRouter`, the user's current directory (used to resolve relative
 * paths), and the raw user-supplied path string.
 */
export interface RunOverviewArgs {
  workspace: Workspace;
  router: BackendRouter;
  /** Absolute path to the user's starting directory; used to resolve relative `inputPath`. */
  cwd: string;
  /** Raw user-supplied path; may be relative or absolute. */
  inputPath: string;
}

/**
 * Orchestrate the `overview` command's pure logic. Resolves the user's input
 * path against `cwd`, runs the locked validation sequence, then dispatches to
 * the first backend that accepts the resulting workspace-relative path.
 *
 * Validation precedence is fixed: missing > outside > ignored > unsupported.
 * The first failing gate decides the typed error thrown.
 *
 * - `displayedPath` on a thrown error is the user's original input string —
 *   relative input → relative; absolute input → absolute. The CLI echoes this
 *   back verbatim in `Cannot answer:` messages.
 * - The backend always receives the workspace-relative POSIX path
 *   (`workspace.toRelative(absPath)`); never the absolute or platform-native
 *   form.
 */
export async function runOverview(args: RunOverviewArgs): Promise<FileSymbols> {
  const { workspace, router, cwd, inputPath } = args;

  const absPath = posix.isAbsolute(inputPath)
    ? posix.normalize(inputPath)
    : posix.resolve(cwd, inputPath);

  // 1. Existence — the file must exist on the workspace's filesystem.
  if (!(await workspace.fs.exists(absPath))) {
    throw new FileNotFoundError(inputPath);
  }

  // 2. Workspace membership — the resolved path must lie under the root.
  if (!workspace.isInWorkspace(absPath)) {
    throw new OutsideWorkspaceError(inputPath, workspace.root);
  }

  const relPath = workspace.toRelative(absPath);

  // 3. Ignore — workspace-aware .gitignore check.
  if (workspace.isIgnored(relPath)) {
    throw new IgnoredFileError(inputPath);
  }

  // 4. Backend routing — first backend whose `accepts` returns true.
  const backend = router.find(relPath);
  if (backend === undefined) {
    const extension = posix.extname(relPath);
    throw new UnsupportedFileError(inputPath, extension);
  }

  return backend.fileSymbols(relPath);
}
