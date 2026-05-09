import { AbstractWorkspace } from "./abstract-workspace.js";
import type { IgnoreScope } from "./ignore/scope.js";
import { NodeFileSystem } from "./node-file-system.js";
import type { FileSystem } from "./file-system.js";

export class NodeWorkspace extends AbstractWorkspace {
  constructor(root: string, fs: FileSystem, scopes: readonly IgnoreScope[]) {
    super(root, fs, scopes);
  }

  static async create(opts: { startDir: string; fs?: FileSystem }): Promise<NodeWorkspace> {
    const fs = opts.fs ?? new NodeFileSystem();
    const deps = await AbstractWorkspace.resolveDependencies({ startDir: opts.startDir, fs });
    return new NodeWorkspace(deps.root, deps.fs, deps.scopes);
  }
}
