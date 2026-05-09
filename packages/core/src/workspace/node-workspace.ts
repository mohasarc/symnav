import { AbstractWorkspace } from "./abstract-workspace.js";
import type { IgnoreScope } from "./ignore/scope.js";
import { NodeFileSystem } from "./node-file-system.js";
import type { WorkspaceFileSystem } from "./file-system.js";

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
