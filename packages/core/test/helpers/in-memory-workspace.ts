import type { Ignore } from "ignore";
import type { WorkspaceFileSystem } from "@symnav/core";
import { AbstractWorkspace } from "@symnav/core";

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

export class InMemoryWorkspace extends AbstractWorkspace {
  constructor(root: string, fs: WorkspaceFileSystem, matcher: Ignore) {
    super(root, fs, matcher);
  }

  static async create(args: {
    files: Record<string, string>;
    startDir?: string;
  }): Promise<InMemoryWorkspace> {
    const fs = inMemoryFileSystem(args.files);
    const startDir = args.startDir ?? defaultStartDir(args.files);
    const deps = await AbstractWorkspace.resolveDependencies({ startDir, fs });
    return new InMemoryWorkspace(deps.root, deps.fs, deps.matcher);
  }
}

function defaultStartDir(files: Record<string, string>): string {
  const dirs = [...computeDirSet(new Set(Object.keys(files)))];
  if (dirs.length === 0) {
    return "/";
  }
  dirs.sort();
  return dirs[0] ?? "/";
}
