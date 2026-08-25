import type { FileSystem } from "./file-system.js";
import type { ResolvedPath, Workspace } from "./workspace.js";

export class WorkspaceCatalog {
  constructor(private readonly fs: FileSystem) {}

  open(startDir: string): Promise<Workspace> {
    return this.unavailable(startDir);
  }

  refresh(startDir: string): Promise<Workspace> {
    return this.unavailable(startDir);
  }

  refreshSelection(startDir: string, selection: readonly ResolvedPath[]): Promise<Workspace> {
    void selection;
    return this.unavailable(startDir);
  }

  private unavailable(startDir: string): Promise<Workspace> {
    void this.fs;
    return Promise.reject(new Error(`Workspace catalog is not initialized for ${startDir}`));
  }
}
