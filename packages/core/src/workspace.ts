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

export interface CreateWorkspaceOptions {
  startDir: string;
  fs: WorkspaceFileSystem;
}

/**
 * Build a `Workspace` rooted at the nearest `.git` ancestor of `startDir`.
 * Throws `NotInWorkspaceError` if no such ancestor exists.
 */
export function createWorkspace(_opts: CreateWorkspaceOptions): Promise<Workspace> {
  return Promise.reject(new Error("createWorkspace not implemented yet"));
}
