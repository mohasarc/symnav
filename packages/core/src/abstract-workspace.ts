import type { WorkspaceFileSystem } from "./file-system.js";
import { NotInWorkspaceError } from "./errors.js";
import { buildIgnoreScopes } from "./build-ignore-scopes.js";
import { findWorkspaceRoot } from "./find-workspace-root.js";
import type { IgnoreScope } from "./ignore-scope.js";
import { isIgnoredByScopes } from "./is-ignored-by-scopes.js";
import { isUnderRoot } from "./is-under-root.js";
import { posixify } from "./posixify.js";
import type { Workspace } from "./workspace.js";

export abstract class AbstractWorkspace implements Workspace {
  protected constructor(
    public readonly root: string,
    public readonly fs: WorkspaceFileSystem,
    protected readonly scopes: readonly IgnoreScope[],
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
    if (relPath === "" || relPath === "/") {
      return false;
    }
    if (relPath === ".git" || relPath.startsWith(".git/")) {
      return true;
    }
    return isIgnoredByScopes(relPath, this.scopes);
  }

  static async resolveDependencies(opts: { startDir: string; fs: WorkspaceFileSystem }): Promise<{
    root: string;
    fs: WorkspaceFileSystem;
    scopes: IgnoreScope[];
  }> {
    const { fs } = opts;
    const startDir = posixify(opts.startDir);
    const root = findWorkspaceRoot(startDir, fs);
    if (root === null) {
      throw new NotInWorkspaceError(opts.startDir);
    }
    const scopes = buildIgnoreScopes(root, fs);
    return { root, fs, scopes };
  }
}
