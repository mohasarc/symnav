import { isAbsolute, posix, resolve } from "node:path";
import type { FileMetadata, FileSystem } from "./file-system.js";
import {
  FileNotFoundError,
  IgnoredFileError,
  DirectoryInputError,
  NotInWorkspaceError,
  OutsideWorkspaceError,
  UnreadableDirectoryWarningCandidateError,
} from "./errors.js";
import { WorkspaceIgnore } from "./ignore/workspace-ignore.js";
import { findWorkspaceRoot } from "./paths/find-root.js";
import { isUnderRoot } from "./paths/is-under-root.js";
import { posixify } from "./paths/posixify.js";
import { relPathFromRoot } from "./paths/rel-from-root.js";

export interface ResolvedPath {
  readonly relative: string;
  readonly absolute: string;
}

export interface WorkspaceFile extends ResolvedPath {
  readonly metadata: FileMetadata;
}

export interface WorkspaceSnapshot {
  readonly root: string;
  readonly files: readonly WorkspaceFile[];
}

export interface Workspace {
  readonly root: string;
  resolveInputPath(inputPath: string, cwd: string): Promise<ResolvedPath>;
  enumerate(): Promise<readonly ResolvedPath[]>;
}

class DefaultWorkspace implements Workspace {
  constructor(
    public readonly root: string,
    private readonly fs: FileSystem,
    private readonly ignore: WorkspaceIgnore,
  ) {}

  async resolveInputPath(inputPath: string, cwd: string): Promise<ResolvedPath> {
    const absolutePath = posixify(isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath));
    if (!(await this.fs.exists(absolutePath))) {
      throw new FileNotFoundError(inputPath);
    }
    if (!isUnderRoot(absolutePath, this.root)) {
      throw new OutsideWorkspaceError(inputPath, this.root);
    }
    const relativePath = relPathFromRoot(absolutePath, this.root);
    if (this.ignore.isIgnored(relativePath)) {
      throw new IgnoredFileError(inputPath);
    }
    if (await this.fs.isDirectory(absolutePath)) {
      throw new DirectoryInputError(relativePath);
    }
    return { relative: relativePath, absolute: absolutePath };
  }

  async enumerate(): Promise<readonly ResolvedPath[]> {
    const results = await this.collect();
    results.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    return results;
  }

  private async collect(): Promise<ResolvedPath[]> {
    const results: ResolvedPath[] = [];
    const pending: string[] = [this.root];
    while (pending.length > 0) {
      const dirAbs = pending.pop() as string;
      let entries: readonly string[];
      try {
        entries = await this.fs.listDir(dirAbs);
      } catch (error) {
        throw new UnreadableDirectoryWarningCandidateError(dirAbs, error);
      }
      for (const entry of entries) {
        const childAbs = posix.join(dirAbs, entry);
        const childRel = relPathFromRoot(childAbs, this.root);
        if (this.ignore.isIgnored(childRel)) {
          continue;
        }
        if (await this.fs.isDirectory(childAbs)) {
          pending.push(childAbs);
        } else {
          results.push({ relative: childRel, absolute: childAbs });
        }
      }
    }
    return results;
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
