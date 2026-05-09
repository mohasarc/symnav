import { NodeFileSystem } from "./file-system.js";
import type { WorkspaceFileSystem } from "./file-system.js";
import { AbstractWorkspace, type IgnoreScope } from "./workspace.js";

export class NodeWorkspace extends AbstractWorkspace {
  constructor(root: string, fs: WorkspaceFileSystem, scopes: readonly IgnoreScope[]) {
    super(root, fs, scopes);
  }

  static async create(opts: {
    startDir: string;
    fs?: WorkspaceFileSystem;
  }): Promise<NodeWorkspace> {
    const fs = opts.fs ?? new NodeFileSystem();
    const deps = await AbstractWorkspace.resolveDependencies({ startDir: opts.startDir, fs });
    return new NodeWorkspace(deps.root, deps.fs, deps.scopes);
  }
}
