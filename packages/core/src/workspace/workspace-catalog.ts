import type { FileSystem } from "./file-system.js";
import { NotInWorkspaceError } from "./errors.js";
import { WorkspaceIgnore } from "./ignore/workspace-ignore.js";
import { findWorkspaceRoot } from "./paths/find-root.js";
import {
  createWorkspace,
  createWorkspaceTurn,
  type ResolvedPath,
  type Workspace,
  type WorkspaceSnapshot,
} from "./workspace.js";

export class WorkspaceCatalog {
  private readonly states = new Map<string, Workspace>();

  constructor(private readonly fs: FileSystem) {}

  async open(startDir: string): Promise<Workspace> {
    const root = this.rootFor(startDir);
    return this.states.get(root) ?? this.refresh(startDir);
  }

  async refresh(startDir: string): Promise<Workspace> {
    const root = this.rootFor(startDir);
    const workspace = await createWorkspace({ startDir: root, fs: this.fs });
    await workspace.snapshot();
    this.states.set(root, workspace);
    return workspace;
  }

  async refreshSelection(startDir: string, selection: readonly ResolvedPath[]): Promise<Workspace> {
    const workspace = await this.refresh(startDir);
    const snapshot: WorkspaceSnapshot = await workspace.snapshot(selection);
    return createWorkspaceTurn({
      root: workspace.root,
      fs: this.fs,
      snapshot,
      ignore: new WorkspaceIgnore(),
    });
  }

  private rootFor(startDir: string): string {
    const root = findWorkspaceRoot(startDir, this.fs);
    if (root === null) throw new NotInWorkspaceError(startDir);
    return root;
  }
}
