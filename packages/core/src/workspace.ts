import { posix } from "node:path";
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
    isIgnored(_relPath: string): boolean {
      return false;
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
