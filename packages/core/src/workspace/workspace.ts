import { posix, win32 } from "node:path";
import type { FileMetadata, FileSystem } from "./file-system.js";
import {
  FileNotFoundError,
  IgnoredFileError,
  DirectoryInputError,
  NestedWorkspacePathError,
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
  enumerate(): Promise<readonly WorkspaceFile[]>;
  snapshot(selection?: readonly ResolvedPath[]): Promise<WorkspaceSnapshot>;
}

class DefaultWorkspace implements Workspace {
  private pathsPromise: Promise<readonly ResolvedPath[]> | undefined;
  private snapshotPromise: Promise<WorkspaceSnapshot> | undefined;
  private enumerationError: UnreadableDirectoryWarningCandidateError | undefined;
  private readonly ignore: WorkspaceIgnore;
  private readonly retainedTurn: boolean;

  constructor(
    public readonly root: string,
    private readonly fs: FileSystem,
    retained?: {
      readonly snapshot: WorkspaceSnapshot;
      readonly ignore: WorkspaceIgnore;
    },
  ) {
    this.ignore = retained?.ignore ?? new WorkspaceIgnore();
    this.retainedTurn = retained !== undefined;
    if (retained) {
      this.snapshotPromise = Promise.resolve(retained.snapshot);
      this.pathsPromise = Promise.resolve(
        retained.snapshot.files.map(({ relative, absolute }) => ({ relative, absolute })),
      );
    }
  }

  async resolveInputPath(inputPath: string, cwd: string): Promise<ResolvedPath> {
    const pathDialect = posix.isAbsolute(this.root) ? posix : win32;
    const absolutePath = posixify(pathDialect.resolve(cwd, inputPath));
    if (!(await this.fs.exists(absolutePath))) {
      throw new FileNotFoundError(inputPath);
    }
    if (!isUnderRoot(absolutePath, this.root)) {
      throw new OutsideWorkspaceError(inputPath, this.root);
    }
    this.assertPathOwnedByWorkspace(inputPath, absolutePath);
    const relativePath = relPathFromRoot(absolutePath, this.root);
    const ignore = this.retainedTurn ? this.ignore : await this.ignoreFor(absolutePath);
    if (ignore.isIgnored(relativePath)) {
      throw new IgnoredFileError(inputPath);
    }
    if (await this.fs.isDirectory(absolutePath)) {
      throw new DirectoryInputError(relativePath);
    }
    return { relative: relativePath, absolute: absolutePath };
  }

  private async ignoreFor(absolutePath: string): Promise<WorkspaceIgnore> {
    const ignore = new WorkspaceIgnore();
    const ancestors: string[] = [];
    let directory = posix.dirname(absolutePath);
    while (isUnderRoot(directory, this.root)) {
      ancestors.unshift(directory);
      if (directory === this.root) break;
      directory = posix.dirname(directory);
    }
    for (const ancestor of ancestors) {
      const ignorePath = posix.join(ancestor, ".gitignore");
      if (!(await this.fs.exists(ignorePath)) || (await this.fs.isDirectory(ignorePath))) continue;
      ignore.addScope(relPathFromRoot(ancestor, this.root), await this.fs.readFile(ignorePath));
    }
    return ignore;
  }

  private assertPathOwnedByWorkspace(inputPath: string, absolutePath: string): void {
    const nearestWorkspaceRoot = findWorkspaceRoot(posix.dirname(absolutePath), this.fs);
    if (nearestWorkspaceRoot !== null && nearestWorkspaceRoot !== this.root) {
      throw new NestedWorkspacePathError(inputPath, this.root, nearestWorkspaceRoot);
    }
  }

  async enumerate(): Promise<readonly WorkspaceFile[]> {
    const snapshot = await this.snapshot();
    if (this.enumerationError) {
      throw this.enumerationError;
    }
    return snapshot.files;
  }

  snapshot(selection?: readonly ResolvedPath[]): Promise<WorkspaceSnapshot> {
    if (selection) {
      return this.captureSnapshot(selection);
    }
    this.snapshotPromise ??= this.captureSnapshot();
    return this.snapshotPromise;
  }

  private async captureSnapshot(selection?: readonly ResolvedPath[]): Promise<WorkspaceSnapshot> {
    const paths = selection ?? (await this.paths());
    const files: WorkspaceFile[] = [];
    for (const path of paths) {
      files.push({ ...path, metadata: await this.fs.metadata(path.absolute) });
    }
    return { root: this.root, files };
  }

  private paths(): Promise<readonly ResolvedPath[]> {
    this.pathsPromise ??= this.capturePaths();
    return this.pathsPromise;
  }

  private async capturePaths(): Promise<readonly ResolvedPath[]> {
    const paths = await this.collectPaths();
    paths.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    return paths;
  }

  private async collectPaths(): Promise<ResolvedPath[]> {
    const results: ResolvedPath[] = [];
    const pending: string[] = [this.root];
    while (pending.length > 0) {
      const dirAbs = pending.pop() as string;
      let entries: readonly string[];
      try {
        entries = await this.fs.listDir(dirAbs);
      } catch (error) {
        if (!DefaultWorkspace.isExpectedListDirError(error)) {
          throw error;
        }
        this.enumerationError ??= new UnreadableDirectoryWarningCandidateError(dirAbs, error);
        continue;
      }
      await this.loadIgnoreScope(dirAbs, entries);
      for (const entry of entries) {
        const childAbs = posix.join(dirAbs, entry);
        const childRel = relPathFromRoot(childAbs, this.root);
        const childIsDirectory = await this.fs.isDirectory(childAbs);
        if (childIsDirectory && (await this.isNestedWorkspaceRoot(childAbs))) {
          continue;
        }
        const ignoreCandidate = childIsDirectory ? `${childRel}/` : childRel;
        if (this.ignore.isIgnored(ignoreCandidate)) {
          continue;
        }
        if (childIsDirectory) {
          pending.push(childAbs);
        } else {
          results.push({ relative: childRel, absolute: childAbs });
        }
      }
    }
    return results;
  }

  private isNestedWorkspaceRoot(directoryAbsolute: string): Promise<boolean> {
    return this.fs.exists(posix.join(directoryAbsolute, ".git"));
  }

  private static isExpectedListDirError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
      return false;
    }
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT" || code === "EACCES";
  }

  private async loadIgnoreScope(
    directoryAbsolute: string,
    entries: readonly string[],
  ): Promise<void> {
    if (!entries.includes(".gitignore")) {
      return;
    }
    const gitignoreAbsolute = posix.join(directoryAbsolute, ".gitignore");
    if (await this.fs.isDirectory(gitignoreAbsolute)) {
      return;
    }
    const directoryRelative = relPathFromRoot(directoryAbsolute, this.root);
    this.ignore.addScope(directoryRelative, await this.fs.readFile(gitignoreAbsolute));
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
  return new DefaultWorkspace(root, fs);
}

export function createWorkspaceTurn(opts: {
  root: string;
  fs: FileSystem;
  snapshot: WorkspaceSnapshot;
  ignore: WorkspaceIgnore;
}): Workspace {
  return new DefaultWorkspace(opts.root, opts.fs, {
    snapshot: opts.snapshot,
    ignore: opts.ignore,
  });
}
