import type { WorkspaceFileSystem } from "./file-system.js";

/**
 * The workspace abstraction. Knows the workspace root (nearest `.git` ancestor
 * of the user's starting directory), exposes a filesystem port, and answers
 * path/ignore questions about workspace-relative paths.
 */
export interface Workspace {
  readonly root: string;
  readonly fs: WorkspaceFileSystem;
  /** Convert an absolute path under root to a workspace-relative POSIX path. */
  toRelative(absPath: string): string;
  /** Convert a workspace-relative POSIX path to an absolute platform path. */
  toAbsolute(relPath: string): string;
  /** Whether the given absolute path lies under the workspace root. */
  isInWorkspace(absPath: string): boolean;
  /** `.gitignore`-aware ignore check for a workspace-relative POSIX path. */
  isIgnored(relPath: string): boolean;
}
