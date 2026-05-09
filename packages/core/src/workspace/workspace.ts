import type { FileSystem } from "./file-system.js";

export interface Workspace {
  readonly root: string;
  readonly fs: FileSystem;
  toRelative(absPath: string): string;
  toAbsolute(relPath: string): string;
  isInWorkspace(absPath: string): boolean;
  isIgnored(relPath: string): boolean;
}
