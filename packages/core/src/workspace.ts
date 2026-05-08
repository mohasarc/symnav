import { posix } from "node:path";
import ignore from "ignore";
import type { Ignore } from "ignore";
import type { WorkspaceFileSystem } from "./file-system.js";
import { NotInWorkspaceError } from "./errors.js";

/**
 * The workspace abstraction. Knows the workspace root (nearest `.git` ancestor
 * of the user's starting directory), exposes a filesystem port, and answers
 * path/ignore questions about workspace-relative paths.
 */
export interface Workspace {
  readonly root: string;
  readonly fs: WorkspaceFileSystem;
  /** Convert an absolute path under root to a workspace-relative POSIX path. */
  toRelative(absPath: string): string;
  /** Convert a workspace-relative POSIX path to an absolute platform path. */
  toAbsolute(relPath: string): string;
  /** Whether the given absolute path lies under the workspace root. */
  isInWorkspace(absPath: string): boolean;
  /** `.gitignore`-aware ignore check for a workspace-relative POSIX path. */
  isIgnored(relPath: string): boolean;
}

export interface CreateWorkspaceOptions {
  startDir: string;
  fs: WorkspaceFileSystem;
}

/**
 * Build a `Workspace` rooted at the nearest `.git` ancestor of `startDir`.
 * Throws `NotInWorkspaceError` if no such ancestor exists.
 */
export async function createWorkspace(opts: CreateWorkspaceOptions): Promise<Workspace> {
  const { fs } = opts;
  const startDir = posix.normalize(opts.startDir);
  const root = findWorkspaceRoot(startDir, fs);
  if (root === null) {
    throw new NotInWorkspaceError(opts.startDir);
  }

  const matcher = buildIgnoreMatcher(root, fs);

  return {
    root,
    fs,
    toRelative(absPath: string): string {
      const normalized = posix.normalize(absPath);
      if (!isUnderRoot(normalized, root)) {
        throw new Error(`Path ${absPath} is not under workspace root ${root}`);
      }
      if (normalized === root) {
        return "";
      }
      return normalized.slice(root.length + 1);
    },
    toAbsolute(relPath: string): string {
      return relPath === "" ? root : `${root}/${relPath}`;
    },
    isInWorkspace(absPath: string): boolean {
      const normalized = posix.normalize(absPath);
      return isUnderRoot(normalized, root);
    },
    isIgnored(relPath: string): boolean {
      if (relPath === "" || relPath === "/") {
        return false;
      }
      const normalized = relPath.replace(/^\/+/, "");
      if (normalized === ".git" || normalized.startsWith(".git/")) {
        return true;
      }
      return matcher.ignores(normalized);
    },
  };
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

/**
 * Build a single `ignore` matcher that aggregates every `.gitignore` file
 * found in the workspace tree (skipping `.git/` itself). Patterns from a
 * `.gitignore` in subdirectory `dir` are rewritten so they apply only to
 * paths under `dir/`, mirroring `gitignore(5)` per-directory scoping.
 */
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

/**
 * Rewrite the patterns from a `.gitignore` so they match against paths that
 * are relative to the workspace root rather than to the directory holding the
 * `.gitignore`.
 *
 * Rules:
 * - Comments and blank lines pass through unchanged.
 * - Negations (`!pattern`) are rewritten with the prefix preserved.
 * - At the workspace root (`scope === ""`), patterns pass through unchanged.
 * - In a subdirectory `scope`:
 *   - Anchored patterns (`/foo`) become `/<scope>/foo`.
 *   - Unanchored patterns (`foo`, `foo/`) become `<scope>/**\/<foo>` so they
 *     match any depth under `<scope>`, mirroring `gitignore(5)` per-directory
 *     scoping.
 */
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
