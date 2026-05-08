import type { Workspace, WorkspaceFileSystem } from "@symnav/core";
import { NotInWorkspaceError } from "@symnav/core";

/** Build a `WorkspaceFileSystem` backed by an in-memory map of files. */
export function inMemoryFileSystem(_files: Record<string, string>): WorkspaceFileSystem {
  throw new Error("inMemoryFileSystem not implemented yet");
}

/**
 * Build a `Workspace` whose underlying filesystem is in-memory.
 *
 * `files` keys are absolute POSIX paths; values are file contents. `.git/HEAD`
 * (or `.git` as a regular file entry) must be present so `createWorkspace` can
 * find a workspace root.
 *
 * `startDir` defaults to the lexicographically smallest directory under the
 * inferred root, so simple tests can omit it.
 */
export function inMemoryWorkspace(args: {
  files: Record<string, string>;
  startDir?: string;
}): Promise<Workspace> {
  void args;
  return Promise.reject(
    new NotInWorkspaceError(args.startDir ?? "<unknown>"),
  );
}
