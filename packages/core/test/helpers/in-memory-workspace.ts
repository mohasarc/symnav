import type { IgnoreScope, WorkspaceFileSystem } from "@symnav/core";
import { AbstractWorkspace } from "@symnav/core";
import { computeDirSet } from "./compute-dir-set.js";
import { InMemoryFileSystem } from "./in-memory-file-system.js";

export class InMemoryWorkspace extends AbstractWorkspace {
  constructor(root: string, fs: WorkspaceFileSystem, scopes: readonly IgnoreScope[]) {
    super(root, fs, scopes);
  }

  static async create(args: {
    files: Record<string, string>;
    startDir?: string;
  }): Promise<InMemoryWorkspace> {
    const fs = new InMemoryFileSystem(args.files);
    const startDir = args.startDir ?? InMemoryWorkspace.defaultStartDir(args.files);
    const deps = await AbstractWorkspace.resolveDependencies({ startDir, fs });
    return new InMemoryWorkspace(deps.root, deps.fs, deps.scopes);
  }

  private static defaultStartDir(files: Record<string, string>): string {
    const dirs = [...computeDirSet(new Set(Object.keys(files)))];
    if (dirs.length === 0) {
      return "/";
    }
    dirs.sort();
    return dirs[0] ?? "/";
  }
}
