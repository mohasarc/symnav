import { dirname } from "node:path/posix";
import type { WorkspaceFileSystem } from "./file-system.js";
import { NotInWorkspaceError } from "./errors.js";

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

function findGitRoot(startDir: string, fs: WorkspaceFileSystem): string | null {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(`${dir}/.git`)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function normalizePosix(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") {
      if (parts.length === 0 && seg === "") parts.push("");
      continue;
    }
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
      else return "";
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/") || "/";
}

export function createWorkspace(opts: CreateWorkspaceOptions): Promise<Workspace> {
  const { startDir, fs } = opts;
  const root = findGitRoot(startDir, fs);
  if (root === null) {
    return Promise.reject(new NotInWorkspaceError(startDir));
  }

  const ws: Workspace = {
    root,
    fs,
    toRelative(absPath) {
      const normalized = normalizePosix(absPath);
      if (normalized === root) return "";
      const prefix = root.endsWith("/") ? root : `${root}/`;
      if (!normalized.startsWith(prefix)) {
        throw new Error(`Path is not under workspace root: ${absPath}`);
      }
      return normalized.slice(prefix.length);
    },
    toAbsolute(relPath) {
      if (relPath === "") return root;
      const sep = root.endsWith("/") ? "" : "/";
      return `${root}${sep}${relPath}`;
    },
    isInWorkspace(absPath) {
      const normalized = normalizePosix(absPath);
      if (normalized === "") return false;
      if (normalized === root) return true;
      const prefix = root.endsWith("/") ? root : `${root}/`;
      return normalized.startsWith(prefix);
    },
    isIgnored() {
      return false;
    },
  };
  return Promise.resolve(ws);
}
