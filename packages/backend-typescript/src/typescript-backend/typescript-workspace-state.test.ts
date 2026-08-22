import { describe, expect, it } from "vitest";

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

describe("TypeScriptWorkspaceState.refresh", () => {
  it("keeps an unchanged source object while sibling deltas are applied", () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/stable.ts": "export const stable = 1;\n",
      "/repo/src/sibling.ts": "export const sibling = 1;\n",
    });
    const state = new TypeScriptWorkspaceState(fs);
    let files = fs.workspaceFiles("src/sibling.ts", "src/stable.ts");

    expect(state.refresh(files)).toEqual({ added: 2, changed: 0, removed: 0, unchanged: 0 });
    const stableSourceFile = state.sourceFile("src/stable.ts");

    fs.setFile("/repo/src/sibling.ts", "export const editedSibling = 2;\n");
    files = fs.workspaceFiles("src/sibling.ts", "src/stable.ts");
    expect(state.refresh(files)).toEqual({ added: 0, changed: 1, removed: 0, unchanged: 1 });
    expect(state.sourceFile("src/stable.ts")).toBe(stableSourceFile);
  });

  it.each([
    {
      trigger: "size only",
      source: "export const longerName = 1;\n",
      metadata: { size: 29, modifiedAtMs: 1 },
      expectedName: "longerName",
    },
    {
      trigger: "modification time only",
      source: "export const b = 2;\n",
      metadata: { size: 20, modifiedAtMs: 2 },
      expectedName: "b",
    },
  ])(
    "reloads and reindexes one file after a $trigger change",
    ({ source, metadata, expectedName }) => {
      const fs = new MutableWorkspaceFileSystem({
        "/repo/src/a.ts": "export const a = 1;\n",
      });
      const state = new TypeScriptWorkspaceState(fs);
      state.refresh(fs.workspaceFiles("src/a.ts"));

      fs.setFile("/repo/src/a.ts", source, metadata);
      const files = fs.workspaceFiles("src/a.ts");

      expect(state.refresh(files)).toEqual({ added: 0, changed: 1, removed: 0, unchanged: 0 });
      expect(declarationNames(state, files)).toEqual([expectedName]);
    },
  );
});
