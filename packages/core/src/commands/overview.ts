import { posix } from "node:path";
import type { BackendRouter } from "../backend/router.js";
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
 * Orchestrate the `overview` command's pure logic. Resolves the input path
 * against `cwd`, hands the resulting workspace-relative path to the first
 * backend that accepts it, and returns the produced IR.
 *
 * Validation gates (existence, workspace membership, ignore, backend support)
 * are layered in subsequent commits; this happy-path version assumes the input
 * resolves to an in-workspace, accepted file.
 */
export async function runOverview(args: RunOverviewArgs): Promise<FileSymbols> {
  const { workspace, router, cwd, inputPath } = args;
  const absPath = posix.isAbsolute(inputPath)
    ? posix.normalize(inputPath)
    : posix.resolve(cwd, inputPath);
  const relPath = workspace.toRelative(absPath);
  const backend = router.find(relPath);
  if (backend === undefined) {
    throw new Error(`No backend accepts ${relPath}`);
  }
  return backend.fileSymbols(relPath);
}
