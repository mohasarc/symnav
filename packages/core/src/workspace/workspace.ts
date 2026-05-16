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

export interface ResolvedPath {
  readonly relative: string;
  readonly absolute: string;
}

export interface Workspace {
  readonly root: string;
  resolveInputPath(inputPath: string, cwd: string): Promise<ResolvedPath>;
}

class DefaultWorkspace implements Workspace {
  constructor(
    public readonly root: string,
    private readonly fs: FileSystem,
    private readonly ignore: WorkspaceIgnore,
  ) {}

  private toRelative(absPath: string): string {
    if (absPath === this.root) {
      return "";
    }
    return absPath.slice(this.root.length + 1);
  }

  async resolveInputPath(inputPath: string, cwd: string): Promise<ResolvedPath> {
    const absolutePath = posixify(isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath));
    if (!(await this.fs.exists(absolutePath))) {
      throw new FileNotFoundError(inputPath);
    }
    if (!isUnderRoot(absolutePath, this.root)) {
      throw new OutsideWorkspaceError(inputPath, this.root);
    }
    const relativePath = this.toRelative(absolutePath);
    if (this.ignore.isIgnored(relativePath)) {
      throw new IgnoredFileError(inputPath);
    }
    return { relative: relativePath, absolute: absolutePath };
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
