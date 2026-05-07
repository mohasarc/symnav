import { createWorkspace, type Workspace, type WorkspaceFileSystem } from "@symnav/core";

export function inMemoryFileSystem(files: Record<string, string>): WorkspaceFileSystem {
  const directories = new Set<string>();
  for (const path of Object.keys(files)) {
    let dir = path;
    while (true) {
      const idx = dir.lastIndexOf("/");
      if (idx <= 0) break;
      dir = dir.slice(0, idx);
      directories.add(dir);
    }
  }

  return {
    async readFile(absPath) {
      const content = files[absPath];
      if (content === undefined) {
        throw new Error(`ENOENT: ${absPath}`);
      }
      return content;
    },
    async exists(absPath) {
      return absPath in files || directories.has(absPath);
    },
    existsSync(absPath) {
      return absPath in files || directories.has(absPath);
    },
    readFileSync(absPath) {
      const content = files[absPath];
      if (content === undefined) {
        throw new Error(`ENOENT: ${absPath}`);
      }
      return content;
    },
    listDirSync(absPath) {
      const prefix = absPath === "/" ? "/" : `${absPath}/`;
      const entries = new Set<string>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf("/");
        entries.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      for (const dir of directories) {
        if (!dir.startsWith(prefix)) continue;
        const rest = dir.slice(prefix.length);
        if (rest === "") continue;
        const slash = rest.indexOf("/");
        entries.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return [...entries];
    },
    isDirectorySync(absPath) {
      return directories.has(absPath);
    },
  };
}

export function inMemoryWorkspace(args: {
  files: Record<string, string>;
  startDir?: string;
}): Promise<Workspace> {
  const fs = inMemoryFileSystem(args.files);
  const startDir = args.startDir ?? defaultStartDir(Object.keys(args.files));
  return createWorkspace({ startDir, fs });
}

function defaultStartDir(paths: readonly string[]): string {
  const dirs = new Set<string>();
  for (const p of paths) {
    const idx = p.lastIndexOf("/");
    dirs.add(idx <= 0 ? "/" : p.slice(0, idx));
  }
  return [...dirs].sort()[0] ?? "/";
}
