import type { WorkspaceFileSystem } from "@symnav/core";
import { computeDirSet } from "./compute-dir-set.js";

export class InMemoryFileSystem implements WorkspaceFileSystem {
  private readonly files: Record<string, string>;
  private readonly fileSet: Set<string>;
  private readonly dirSet: Set<string>;

  constructor(files: Record<string, string>) {
    this.files = files;
    this.fileSet = new Set<string>(Object.keys(files));
    this.dirSet = computeDirSet(this.fileSet);
  }

  async readFile(absPath: string): Promise<string> {
    return this.readFileSyncImpl(absPath);
  }

  async exists(absPath: string): Promise<boolean> {
    return this.fileSet.has(absPath) || this.dirSet.has(absPath);
  }

  existsSync(absPath: string): boolean {
    return this.fileSet.has(absPath) || this.dirSet.has(absPath);
  }

  readFileSync(absPath: string): string {
    return this.readFileSyncImpl(absPath);
  }

  listDirSync(absPath: string): readonly string[] {
    if (!this.dirSet.has(absPath)) {
      throw new Error(`ENOTDIR: not a directory: ${absPath}`);
    }
    const prefix = absPath === "/" ? "/" : `${absPath}/`;
    const children = new Set<string>();
    for (const path of this.fileSet) {
      if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf("/");
        children.add(slash === -1 ? rest : rest.slice(0, slash));
      }
    }
    for (const path of this.dirSet) {
      if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        if (rest.length > 0) {
          const slash = rest.indexOf("/");
          children.add(slash === -1 ? rest : rest.slice(0, slash));
        }
      }
    }
    return [...children].sort();
  }

  isDirectorySync(absPath: string): boolean {
    return this.dirSet.has(absPath);
  }

  private readFileSyncImpl(absPath: string): string {
    const content = this.files[absPath];
    if (content === undefined) {
      throw new Error(`ENOENT: no such file: ${absPath}`);
    }
    return content;
  }
}
