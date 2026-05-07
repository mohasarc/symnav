import { dirname } from "node:path/posix";
import ignore, { type Ignore } from "ignore";
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

function joinAbs(root: string, relDir: string, name: string): string {
  const sep1 = root.endsWith("/") ? "" : "/";
  if (relDir === "") return `${root}${sep1}${name}`;
  return `${root}${sep1}${relDir}/${name}`;
}

function buildIgnoreMatcher(root: string, fs: WorkspaceFileSystem): Ignore {
  const matcher = ignore();
  const stack: string[] = [""];

  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const absDir = relDir === "" ? root : joinAbs(root, "", relDir);

    let entries: readonly string[];
    try {
      entries = fs.listDirSync(absDir);
    } catch {
      continue;
    }

    if (entries.includes(".gitignore")) {
      const gitignoreAbs = joinAbs(root, relDir, ".gitignore");
      let content: string;
      try {
        content = fs.readFileSync(gitignoreAbs);
      } catch {
        content = "";
      }
      const scoped =
        relDir === ""
          ? content
          : content
              .split("\n")
              .map((line) => scopeIgnoreLine(line, relDir))
              .join("\n");
      matcher.add(scoped);
    }

    for (const name of entries) {
      if (name === ".git") continue;
      const childRel = relDir === "" ? name : `${relDir}/${name}`;
      const childAbs = joinAbs(root, relDir, name);
      if (matcher.ignores(childRel)) continue;
      if (fs.isDirectorySync(childAbs)) {
        stack.push(childRel);
      }
    }
  }

  return matcher;
}

function scopeIgnoreLine(line: string, scope: string): string {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return line;
  let negated = false;
  let body = line;
  if (body.startsWith("!")) {
    negated = true;
    body = body.slice(1);
  }
  const prefix = negated ? "!" : "";
  if (body.startsWith("/")) {
    return `${prefix}${scope}${body}`;
  }
  if (body.includes("/") && !body.endsWith("/")) {
    return `${prefix}${scope}/${body}`;
  }
  return `${prefix}${scope}/**/${body}`;
}

export function createWorkspace(opts: CreateWorkspaceOptions): Promise<Workspace> {
  const { startDir, fs } = opts;
  const root = findGitRoot(startDir, fs);
  if (root === null) {
    return Promise.reject(new NotInWorkspaceError(startDir));
  }

  const matcher = buildIgnoreMatcher(root, fs);

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
    isIgnored(relPath) {
      if (relPath === ".git" || relPath.startsWith(".git/")) return true;
      if (relPath === "") return false;
      return matcher.ignores(relPath);
    },
  };
  return Promise.resolve(ws);
}
