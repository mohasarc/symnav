import { posix } from "node:path";
import ignore from "ignore";
import type { Ignore } from "ignore";
import type { WorkspaceFileSystem } from "./file-system.js";
import { NotInWorkspaceError } from "./errors.js";

export { NodeFileSystem } from "./file-system.js";
export type { WorkspaceFileSystem } from "./file-system.js";

export interface Workspace {
  readonly root: string;
  readonly fs: WorkspaceFileSystem;
  toRelative(absPath: string): string;
  toAbsolute(relPath: string): string;
  isInWorkspace(absPath: string): boolean;
  isIgnored(relPath: string): boolean;
}

export interface CreateWorkspaceOptions {
  startDir: string;
  fs: WorkspaceFileSystem;
}

export interface IgnoreScope {
  readonly dirRelToRoot: string;
  readonly matcher: Ignore;
}

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
    for (const scope of this.scopes) {
      const relToScope = pathRelativeToScope(relPath, scope.dirRelToRoot);
      if (relToScope === null) {
        continue;
      }
      if (scope.matcher.ignores(relToScope)) {
        return true;
      }
    }
    return false;
  }

  static async resolveDependencies(opts: CreateWorkspaceOptions): Promise<{
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

class WorkspaceImpl extends AbstractWorkspace {
  constructor(root: string, fs: WorkspaceFileSystem, scopes: readonly IgnoreScope[]) {
    super(root, fs, scopes);
  }
}

export async function createWorkspace(opts: CreateWorkspaceOptions): Promise<Workspace> {
  const { root, fs, scopes } = await AbstractWorkspace.resolveDependencies(opts);
  return new WorkspaceImpl(root, fs, scopes);
}

function posixify(input: string): string {
  if (input.startsWith("\\\\") || input.startsWith("//")) {
    throw new Error(`UNC paths are not supported: ${input}`);
  }
  return posix.normalize(input.replace(/\\/g, "/"));
}

function pathRelativeToScope(relPath: string, dirRelToRoot: string): string | null {
  if (dirRelToRoot === "") {
    return relPath;
  }
  const prefix = `${dirRelToRoot}/`;
  if (relPath === dirRelToRoot) {
    return "";
  }
  if (relPath.startsWith(prefix)) {
    return relPath.slice(prefix.length);
  }
  return null;
}

function findWorkspaceRoot(startDir: string, fs: WorkspaceFileSystem): string | null {
  let current = startDir;
  while (true) {
    const gitPath = posix.join(current, ".git");
    if (fs.existsSync(gitPath)) {
      return current;
    }
    const parent = posix.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function isUnderRoot(normalizedAbs: string, root: string): boolean {
  if (normalizedAbs === root) {
    return true;
  }
  const prefix = root === "/" ? "/" : `${root}/`;
  return normalizedAbs.startsWith(prefix);
}

function buildIgnoreScopes(root: string, fs: WorkspaceFileSystem): IgnoreScope[] {
  const scopes: IgnoreScope[] = [];
  walkGitignores(root, root, fs, scopes);
  return scopes;
}

function walkGitignores(
  dirAbs: string,
  root: string,
  fs: WorkspaceFileSystem,
  scopes: IgnoreScope[],
): void {
  const dirRelToRoot = relPathFromRoot(dirAbs, root);
  const gitignorePath = posix.join(dirAbs, ".gitignore");
  if (fs.existsSync(gitignorePath) && !fs.isDirectorySync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath);
    scopes.push({ dirRelToRoot, matcher: ignore().add(content) });
  }
  let entries: readonly string[];
  try {
    entries = fs.listDirSync(dirAbs);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".git") {
      continue;
    }
    const childAbs = posix.join(dirAbs, entry);
    if (!fs.isDirectorySync(childAbs)) {
      continue;
    }
    const childRelToRoot = dirRelToRoot === "" ? entry : `${dirRelToRoot}/${entry}`;
    if (isIgnoredByScopes(`${childRelToRoot}/`, scopes)) {
      continue;
    }
    walkGitignores(childAbs, root, fs, scopes);
  }
}

function isIgnoredByScopes(relPath: string, scopes: readonly IgnoreScope[]): boolean {
  for (const scope of scopes) {
    const relToScope = pathRelativeToScope(relPath, scope.dirRelToRoot);
    if (relToScope === null) {
      continue;
    }
    if (scope.matcher.ignores(relToScope)) {
      return true;
    }
  }
  return false;
}

function relPathFromRoot(dirAbs: string, root: string): string {
  if (dirAbs === root) {
    return "";
  }
  const prefix = root === "/" ? "/" : `${root}/`;
  return dirAbs.startsWith(prefix) ? dirAbs.slice(prefix.length) : "";
}
