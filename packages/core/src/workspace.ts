import type { WorkspaceFileSystem } from "./file-system.js";

export interface Workspace {
  readonly root: string;
  readonly fs: WorkspaceFileSystem;
  toRelative(absPath: string): string;
  toAbsolute(relPath: string): string;
  isInWorkspace(absPath: string): boolean;
  isIgnored(relPath: string): boolean;
}

export interface CreateWorkspaceOptions {
  startDir: string;
  fs: WorkspaceFileSystem;
}

export function createWorkspace(_opts: CreateWorkspaceOptions): Promise<Workspace> {
  throw new Error("createWorkspace: not yet implemented");
}
