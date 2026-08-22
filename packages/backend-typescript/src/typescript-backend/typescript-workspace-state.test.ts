import {
  InMemoryFileSystem,
  type FileMetadata,
  type FileSystem,
  type WorkspaceFile,
} from "@symnav/core";

import { TypeScriptWorkspaceState } from "./typescript-workspace-state.js";

class MutableWorkspaceFileSystem implements FileSystem {
  private readonly contents = new Map<string, string>();
  private readonly revisions = new Map<string, FileMetadata>();
  private readonly failingReads = new Set<string>();
  private readonly failingReadObservers = new Map<string, () => void>();

  constructor(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      this.setFile(path, content, { size: Buffer.byteLength(content), modifiedAtMs: 1 });
    }
  }

  setFile(path: string, content: string, metadata?: FileMetadata): void {
    const previous = this.revisions.get(path);
    this.contents.set(path, content);
    this.revisions.set(
      path,
      metadata ?? {
        size: Buffer.byteLength(content),
        modifiedAtMs: (previous?.modifiedAtMs ?? 0) + 1,
      },
    );
  }

  deleteFile(path: string): void {
    this.contents.delete(path);
    this.revisions.delete(path);
    this.failingReads.delete(path);
    this.failingReadObservers.delete(path);
  }

  failReadsFor(path: string, observer?: () => void): void {
    this.failingReads.add(path);
    if (observer) {
      this.failingReadObservers.set(path, observer);
    }
  }

  restoreReadsFor(path: string): void {
    this.failingReads.delete(path);
    this.failingReadObservers.delete(path);
  }

  workspaceFiles(...relativePaths: string[]): readonly WorkspaceFile[] {
    return relativePaths.map((relative) => {
      const absolute = `/repo/${relative}`;
      return { relative, absolute, metadata: this.metadataSync(absolute) };
    });
  }

  readFile(absPath: string): Promise<string> {
    return Promise.resolve(this.readFileSync(absPath));
  }

  exists(absPath: string): Promise<boolean> {
    return Promise.resolve(this.existsSync(absPath));
  }

  listDir(absPath: string): Promise<readonly string[]> {
    return Promise.resolve(this.delegate().listDirSync(absPath));
  }

  isDirectory(absPath: string): Promise<boolean> {
    return Promise.resolve(this.delegate().isDirectorySync(absPath));
  }

  metadata(absPath: string): Promise<FileMetadata> {
    return Promise.resolve(this.metadataSync(absPath));
  }

  existsSync(absPath: string): boolean {
    return this.delegate().existsSync(absPath);
  }

  readFileSync(absPath: string): string {
    if (this.failingReads.has(absPath)) {
      this.failingReadObservers.get(absPath)?.();
      throw new Error(`read failed: ${absPath}`);
    }
    const content = this.contents.get(absPath);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file: ${absPath}`);
    }
    return content;
  }

  listDirSync(absPath: string): readonly string[] {
    return this.delegate().listDirSync(absPath);
  }

  isDirectorySync(absPath: string): boolean {
    return this.delegate().isDirectorySync(absPath);
  }

  metadataSync(absPath: string): FileMetadata {
    const metadata = this.revisions.get(absPath);
    if (!metadata) {
      throw new Error(`ENOENT: no such file: ${absPath}`);
    }
    return metadata;
  }

  private delegate(): InMemoryFileSystem {
    return new InMemoryFileSystem(Object.fromEntries(this.contents));
  }
}

function declarationNames(
  state: TypeScriptWorkspaceState,
  files: readonly WorkspaceFile[],
): readonly string[] {
  return state
    .allDeclarations(files)
    .map((declaration) => declaration.identity.segments.at(-1)?.name ?? "");
}
