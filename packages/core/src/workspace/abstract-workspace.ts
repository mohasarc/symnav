import type { FileSystem } from "./file-system.js";
import { NotInWorkspaceError } from "./errors.js";
import { WorkspaceIgnore } from "./ignore/workspace-ignore.js";
import { findWorkspaceRoot } from "./paths/find-root.js";
import { isUnderRoot } from "./paths/is-under-root.js";
import { posixify } from "./paths/posixify.js";
import type { Workspace } from "./workspace.js";

export abstract class AbstractWorkspace implements Workspace {
  protected constructor(
    public readonly root: string,
    public readonly fs: FileSystem,
    private readonly ignore: WorkspaceIgnore,
  ) {}

  toRelative(absPath: string): string {
    const normalized = posixify(absPath);
    if (!isUnderRoot(normalized, this.root)) {
      throw new Error(`Path ${absPath} is not under workspace root ${this.root}`);
    }
    if (normalized === this.root) {
      return "";
    }
    return normalized.slice(this.root.length + 1);
  }

  toAbsolute(relPath: string): string {
    return relPath === "" ? this.root : `${this.root}/${relPath}`;
  }

  isInWorkspace(absPath: string): boolean {
    const normalized = posixify(absPath);
    return isUnderRoot(normalized, this.root);
  }

  isIgnored(relPath: string): boolean {
    return this.ignore.isIgnored(relPath);
  }

  static async resolveDependencies(opts: { startDir: string; fs: FileSystem }): Promise<{
    root: string;
    fs: FileSystem;
    ignore: WorkspaceIgnore;
  }> {
    const { fs } = opts;
    const startDir = posixify(opts.startDir);
    const root = findWorkspaceRoot(startDir, fs);
    if (root === null) {
      throw new NotInWorkspaceError(opts.startDir);
    }
    const ignore = WorkspaceIgnore.build(root, fs);
    return { root, fs, ignore };
  }
}
