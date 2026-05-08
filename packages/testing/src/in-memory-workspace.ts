import type { Workspace, WorkspaceFileSystem } from "@symnav/core";
import { createWorkspace } from "@symnav/core";

/**
 * Build a `WorkspaceFileSystem` backed by an in-memory map of files.
 *
 * Keys are absolute POSIX paths; values are file contents. Directory existence
 * is inferred from the file map: a directory exists when one or more entries
 * are nested under it.
 */
export function inMemoryFileSystem(files: Record<string, string>): WorkspaceFileSystem {
  const fileSet = new Set<string>(Object.keys(files));
  const dirSet = computeDirSet(fileSet);

  return {
    async readFile(absPath: string): Promise<string> {
      return readFileSyncImpl(absPath);
    },
    async exists(absPath: string): Promise<boolean> {
      return fileSet.has(absPath) || dirSet.has(absPath);
    },
    existsSync(absPath: string): boolean {
      return fileSet.has(absPath) || dirSet.has(absPath);
    },
    readFileSync(absPath: string): string {
      return readFileSyncImpl(absPath);
    },
    listDirSync(absPath: string): readonly string[] {
      if (!dirSet.has(absPath)) {
        throw new Error(`ENOTDIR: not a directory: ${absPath}`);
      }
      const prefix = absPath === "/" ? "/" : `${absPath}/`;
      const children = new Set<string>();
      for (const path of fileSet) {
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          const slash = rest.indexOf("/");
          children.add(slash === -1 ? rest : rest.slice(0, slash));
        }
      }
      for (const path of dirSet) {
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          if (rest.length > 0) {
            const slash = rest.indexOf("/");
            children.add(slash === -1 ? rest : rest.slice(0, slash));
          }
        }
      }
      return [...children].sort();
    },
    isDirectorySync(absPath: string): boolean {
      return dirSet.has(absPath);
    },
  };

  function readFileSyncImpl(absPath: string): string {
    const content = files[absPath];
    if (content === undefined) {
      throw new Error(`ENOENT: no such file: ${absPath}`);
    }
    return content;
  }
}

function computeDirSet(fileSet: Set<string>): Set<string> {
  const dirs = new Set<string>();
  for (const filePath of fileSet) {
    const segments = filePath.split("/");
    // walk every prefix dir: ["", "repo", "pkg", "x.ts"] → "/", "/repo", "/repo/pkg"
    let current = "";
    for (let i = 1; i < segments.length - 1; i++) {
      current = `${current}/${segments[i]}`;
      dirs.add(current);
    }
    if (segments.length > 1) {
      dirs.add("/");
    }
  }
  return dirs;
}

/**
 * Build a `Workspace` whose underlying filesystem is in-memory.
 *
 * `files` keys are absolute POSIX paths; values are file contents. `.git/HEAD`
 * (or `.git` as a regular file entry) must be present so `createWorkspace` can
 * find a workspace root.
 *
 * `startDir` defaults to the lexicographically smallest directory under the
 * inferred root, so simple tests can omit it.
 */
export function inMemoryWorkspace(args: {
  files: Record<string, string>;
  startDir?: string;
}): Promise<Workspace> {
  const fs = inMemoryFileSystem(args.files);
  const startDir = args.startDir ?? defaultStartDir(args.files);
  return createWorkspace({ startDir, fs });
}

function defaultStartDir(files: Record<string, string>): string {
  const dirs = [...computeDirSet(new Set(Object.keys(files)))];
  if (dirs.length === 0) {
    return "/";
  }
  dirs.sort();
  return dirs[0] ?? "/";
}
