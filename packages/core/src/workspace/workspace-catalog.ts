import { posix } from "node:path";

import type { FileMetadata, FileSystem } from "./file-system.js";
import { WorkspaceIgnore } from "./ignore/workspace-ignore.js";
import { findWorkspaceRoot } from "./paths/find-root.js";
import { posixify } from "./paths/posixify.js";
import { relPathFromRoot } from "./paths/rel-from-root.js";
import {
  createWorkspaceTurn,
  type ResolvedPath,
  type Workspace,
  type WorkspaceFile,
  type WorkspaceSnapshot,
} from "./workspace.js";
import { NotInWorkspaceError } from "./errors.js";

interface CatalogEntry {
  readonly name: string;
  readonly directory: boolean;
}

interface CatalogDirectory {
  readonly metadata: FileMetadata;
  readonly entries: readonly CatalogEntry[];
}

interface CatalogIgnoreFile {
  readonly metadata: FileMetadata;
  readonly content: string;
}

interface CatalogState {
  readonly root: string;
  readonly directories: ReadonlyMap<string, CatalogDirectory>;
  readonly ignoreFiles: ReadonlyMap<string, CatalogIgnoreFile>;
  readonly files: ReadonlyMap<string, WorkspaceFile>;
  readonly snapshot: WorkspaceSnapshot;
  readonly ignore: WorkspaceIgnore;
}

export class WorkspaceCatalog {
  private readonly states = new Map<string, CatalogState>();

  constructor(private readonly fs: FileSystem) {}

  async open(startDir: string): Promise<Workspace> {
    const root = this.rootFor(startDir);
    const state = this.states.get(root);
    if (state === undefined) return this.refresh(startDir);
    return WorkspaceCatalog.workspaceFrom(state, this.fs);
  }

  async refresh(startDir: string): Promise<Workspace> {
    const root = this.rootFor(startDir);
    const previous = this.states.get(root);
    const next = await this.capture(root, previous);
    this.states.set(root, next);
    return WorkspaceCatalog.workspaceFrom(next, this.fs);
  }

  async refreshSelection(startDir: string, selection: readonly ResolvedPath[]): Promise<Workspace> {
    const workspace = await this.refresh(startDir);
    const snapshot = await workspace.snapshot(selection);
    const state = this.states.get(workspace.root) as CatalogState;
    return createWorkspaceTurn({
      root: workspace.root,
      fs: this.fs,
      snapshot,
      ignore: state.ignore,
    });
  }

  private rootFor(startDir: string): string {
    const root = findWorkspaceRoot(posixify(startDir), this.fs);
    if (root === null) throw new NotInWorkspaceError(startDir);
    return root;
  }

  private async capture(root: string, previous: CatalogState | undefined): Promise<CatalogState> {
    const directories = new Map<string, CatalogDirectory>();
    const ignoreFiles = new Map<string, CatalogIgnoreFile>();
    const files = new Map<string, WorkspaceFile>();
    const ignore = new WorkspaceIgnore();
    const pending = [root];

    while (pending.length > 0) {
      const directoryAbsolute = pending.pop() as string;
      const directory = await this.directory(directoryAbsolute, previous);
      directories.set(directoryAbsolute, directory);
      const ignoreMetadata = await this.loadIgnore(
        root,
        directoryAbsolute,
        directory.entries,
        previous,
        ignore,
        ignoreFiles,
      );

      for (const entry of directory.entries) {
        const absolute = posix.join(directoryAbsolute, entry.name);
        const relative = relPathFromRoot(absolute, root);
        if (entry.directory) {
          if (await this.fs.exists(posix.join(absolute, ".git"))) continue;
          if (!ignore.isIgnored(`${relative}/`)) pending.push(absolute);
          continue;
        }
        if (ignore.isIgnored(relative)) continue;
        const metadata =
          entry.name === ".gitignore" && ignoreMetadata !== undefined
            ? ignoreMetadata
            : await this.fs.metadata(absolute);
        const previousFile = previous?.files.get(relative);
        const file =
          previousFile?.metadata.changeToken === metadata.changeToken
            ? previousFile
            : WorkspaceCatalog.file(relative, absolute, metadata);
        files.set(relative, file);
      }
    }

    const orderedFiles = [...files.values()].sort((left, right) =>
      left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0,
    );
    const snapshot = Object.freeze({
      root,
      files: Object.freeze(orderedFiles),
    });
    return { root, directories, ignoreFiles, files, snapshot, ignore };
  }

  private async directory(
    absolute: string,
    previous: CatalogState | undefined,
  ): Promise<CatalogDirectory> {
    const metadata = await this.fs.metadata(absolute);
    const retained = previous?.directories.get(absolute);
    if (retained?.metadata.changeToken === metadata.changeToken) return retained;
    const names = [...(await this.fs.listDir(absolute))].sort();
    const entries: CatalogEntry[] = [];
    for (const name of names) {
      entries.push({ name, directory: await this.fs.isDirectory(posix.join(absolute, name)) });
    }
    return { metadata, entries };
  }

  private async loadIgnore(
    root: string,
    directoryAbsolute: string,
    entries: readonly CatalogEntry[],
    previous: CatalogState | undefined,
    ignore: WorkspaceIgnore,
    ignoreFiles: Map<string, CatalogIgnoreFile>,
  ): Promise<FileMetadata | undefined> {
    const entry = entries.find((candidate) => candidate.name === ".gitignore");
    if (entry === undefined || entry.directory) return undefined;
    const absolute = posix.join(directoryAbsolute, entry.name);
    const metadata = await this.fs.metadata(absolute);
    const retained = previous?.ignoreFiles.get(absolute);
    const content =
      retained?.metadata.changeToken === metadata.changeToken
        ? retained.content
        : await this.fs.readFile(absolute);
    ignore.addScope(relPathFromRoot(directoryAbsolute, root), content);
    ignoreFiles.set(absolute, { metadata, content });
    return metadata;
  }

  private static file(relative: string, absolute: string, metadata: FileMetadata): WorkspaceFile {
    return Object.freeze({ relative, absolute, metadata: Object.freeze({ ...metadata }) });
  }

  private static workspaceFrom(state: CatalogState, fs: FileSystem): Workspace {
    return createWorkspaceTurn({
      root: state.root,
      fs,
      snapshot: state.snapshot,
      ignore: state.ignore,
    });
  }
}
