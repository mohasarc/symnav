import ignore from "ignore";
import type { Ignore } from "ignore";
import { posix } from "node:path";
import type { FileSystem } from "../file-system.js";
import { relPathFromRoot } from "../paths/rel-from-root.js";

interface IgnoreScope {
  readonly dirRelToRoot: string;
  readonly matcher: Ignore;
}

export class WorkspaceIgnore {
  private constructor(private readonly scopes: readonly IgnoreScope[]) {}

  static build(root: string, fs: FileSystem): WorkspaceIgnore {
    const scopes: IgnoreScope[] = [];
    WorkspaceIgnore.walk(root, root, fs, scopes);
    return new WorkspaceIgnore(scopes);
  }

  private static walk(dirAbs: string, root: string, fs: FileSystem, scopes: IgnoreScope[]): void {
    const dirRelToRoot = relPathFromRoot(dirAbs, root);
    const gitignorePath = posix.join(dirAbs, ".gitignore");
    if (fs.existsSync(gitignorePath) && !fs.isDirectorySync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath);
      scopes.push({ dirRelToRoot, matcher: ignore().add(content) });
    }
    let entries: readonly string[];
    try {
      entries = fs.listDirSync(dirAbs);
    } catch (err) {
      if (WorkspaceIgnore.isExpectedListDirError(err)) {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const childAbs = posix.join(dirAbs, entry);
      if (!fs.isDirectorySync(childAbs)) {
        continue;
      }
      const childRelToRoot = dirRelToRoot === "" ? entry : `${dirRelToRoot}/${entry}`;
      if (WorkspaceIgnore.isGitInternal(childRelToRoot)) {
        continue;
      }
      if (WorkspaceIgnore.matchesAnyScope(`${childRelToRoot}/`, scopes)) {
        continue;
      }
      WorkspaceIgnore.walk(childAbs, root, fs, scopes);
    }
  }

  private static isGitInternal(relPath: string): boolean {
    return relPath === ".git" || relPath.startsWith(".git/");
  }

  private static isExpectedListDirError(err: unknown): boolean {
    if (typeof err !== "object" || err === null) {
      return false;
    }
    const code = (err as { code?: unknown }).code;
    return code === "ENOENT" || code === "EACCES";
  }

  private static pathRelativeToScope(relPath: string, dirRelToRoot: string): string | null {
    if (dirRelToRoot === "") {
      return relPath;
    }
    if (relPath === dirRelToRoot) {
      return "";
    }
    const prefix = `${dirRelToRoot}/`;
    if (relPath.startsWith(prefix)) {
      return relPath.slice(prefix.length);
    }
    return null;
  }

  private static matchesAnyScope(relPath: string, scopes: readonly IgnoreScope[]): boolean {
    for (const scope of scopes) {
      const relToScope = WorkspaceIgnore.pathRelativeToScope(relPath, scope.dirRelToRoot);
      if (relToScope === null) {
        continue;
      }
      if (scope.matcher.ignores(relToScope)) {
        return true;
      }
    }
    return false;
  }

  isIgnored(relPath: string): boolean {
    if (relPath === "" || relPath === "/") {
      return false;
    }
    if (WorkspaceIgnore.isGitInternal(relPath)) {
      return true;
    }
    return WorkspaceIgnore.matchesAnyScope(relPath, this.scopes);
  }
}
