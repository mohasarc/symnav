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

export abstract class AbstractWorkspace implements Workspace {
  protected constructor(
    public readonly root: string,
    public readonly fs: WorkspaceFileSystem,
    protected readonly matcher: Ignore,
  ) {}

  toRelative(absPath: string): string {
    const normalized = posix.normalize(absPath);
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
    const normalized = posix.normalize(absPath);
    return isUnderRoot(normalized, this.root);
  }

  isIgnored(relPath: string): boolean {
    if (relPath === "" || relPath === "/") {
      return false;
    }
    const normalized = relPath.replace(/^\/+/, "");
    if (normalized === ".git" || normalized.startsWith(".git/")) {
      return true;
    }
    return this.matcher.ignores(normalized);
  }

  static async resolveDependencies(opts: CreateWorkspaceOptions): Promise<{
    root: string;
    fs: WorkspaceFileSystem;
    matcher: Ignore;
  }> {
    const { fs } = opts;
    const startDir = posix.normalize(opts.startDir);
    const root = findWorkspaceRoot(startDir, fs);
    if (root === null) {
      throw new NotInWorkspaceError(opts.startDir);
    }
    const matcher = buildIgnoreMatcher(root, fs);
    return { root, fs, matcher };
  }
}

class WorkspaceImpl extends AbstractWorkspace {
  constructor(root: string, fs: WorkspaceFileSystem, matcher: Ignore) {
    super(root, fs, matcher);
  }
}

export async function createWorkspace(opts: CreateWorkspaceOptions): Promise<Workspace> {
  const { root, fs, matcher } = await AbstractWorkspace.resolveDependencies(opts);
  return new WorkspaceImpl(root, fs, matcher);
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

function buildIgnoreMatcher(root: string, fs: WorkspaceFileSystem): Ignore {
  const matcher = ignore();
  walkGitignores(root, root, fs, (gitignorePath, dirRelToRoot) => {
    const content = fs.readFileSync(gitignorePath);
    const rewritten = rewritePatternsForScope(content, dirRelToRoot);
    matcher.add(rewritten);
  });
  return matcher;
}

function walkGitignores(
  dirAbs: string,
  root: string,
  fs: WorkspaceFileSystem,
  onGitignore: (gitignorePath: string, dirRelToRoot: string) => void,
): void {
  const gitignorePath = posix.join(dirAbs, ".gitignore");
  if (fs.existsSync(gitignorePath) && !fs.isDirectorySync(gitignorePath)) {
    const dirRelToRoot = relPathFromRoot(dirAbs, root);
    onGitignore(gitignorePath, dirRelToRoot);
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
    if (fs.isDirectorySync(childAbs)) {
      walkGitignores(childAbs, root, fs, onGitignore);
    }
  }
}

function relPathFromRoot(dirAbs: string, root: string): string {
  if (dirAbs === root) {
    return "";
  }
  const prefix = root === "/" ? "/" : `${root}/`;
  return dirAbs.startsWith(prefix) ? dirAbs.slice(prefix.length) : "";
}

function rewritePatternsForScope(content: string, scope: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    if (scope === "") {
      out.push(line);
      continue;
    }
    let negate = false;
    let body = trimmed;
    if (body.startsWith("!")) {
      negate = true;
      body = body.slice(1);
    }
    let rewritten: string;
    if (body.startsWith("/")) {
      rewritten = `/${scope}${body}`;
    } else {
      rewritten = `${scope}/**/${body}`;
    }
    out.push(`${negate ? "!" : ""}${rewritten}`);
  }
  return out.join("\n");
}
