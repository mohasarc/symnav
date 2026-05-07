import type { Workspace, WorkspaceFileSystem } from "@symnav/core";

export function inMemoryFileSystem(
  _files: Record<string, string>,
): WorkspaceFileSystem {
  throw new Error("inMemoryFileSystem: not yet implemented");
}

export function inMemoryWorkspace(_args: {
  files: Record<string, string>;
  startDir?: string;
}): Promise<Workspace> {
  throw new Error("inMemoryWorkspace: not yet implemented");
}
