import { isAbsolute, resolve } from "node:path";
import type { FileSystem } from "./file-system.js";
import {
  FileNotFoundError,
  IgnoredFileError,
  NotInWorkspaceError,
  OutsideWorkspaceError,
} from "./errors.js";
import { WorkspaceIgnore } from "./ignore/workspace-ignore.js";
import { findWorkspaceRoot } from "./paths/find-root.js";
import { isUnderRoot } from "./paths/is-under-root.js";
import { posixify } from "./paths/posixify.js";

export interface Workspace {
  readonly root: string;
  toRelative(absPath: string): string;
  toAbsolute(relPath: string): string;
  isInWorkspace(absPath: string): boolean;
  isIgnored(relPath: string): boolean;
  resolveInputPath(inputPath: string, fromDir: string): Promise<string>;
}

class DefaultWorkspace implements Workspace {
  constructor(
    public readonly root: string,
    private readonly fs: FileSystem,
    private readonly ignore: WorkspaceIgnore,
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
    return isUnderRoot(posixify(absPath), this.root);
  }

  isIgnored(relPath: string): boolean {
    return this.ignore.isIgnored(relPath);
  }

  async resolveInputPath(inputPath: string, fromDir: string): Promise<string> {
    const absolutePath = isAbsolute(inputPath) ? inputPath : resolve(fromDir, inputPath);
    if (!(await this.fs.exists(absolutePath))) {
      throw new FileNotFoundError(inputPath);
    }
    if (!this.isInWorkspace(absolutePath)) {
      throw new OutsideWorkspaceError(inputPath, this.root);
    }
    const relativePath = this.toRelative(absolutePath);
    if (this.isIgnored(relativePath)) {
      throw new IgnoredFileError(inputPath);
    }
    return relativePath;
  }
}

export async function createWorkspace(opts: {
  startDir: string;
  fs: FileSystem;
}): Promise<Workspace> {
  const { fs } = opts;
  const startDir = posixify(opts.startDir);
  const root = findWorkspaceRoot(startDir, fs);
  if (root === null) {
    throw new NotInWorkspaceError(opts.startDir);
  }
  const ignore = WorkspaceIgnore.build(root, fs);
  return new DefaultWorkspace(root, fs, ignore);
}
