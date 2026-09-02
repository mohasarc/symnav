import { describe, expect, it } from "vitest";

import {
  InMemoryFileSystem,
  type FileMetadata,
  type FileSystem,
  type SymbolIdentity,
  type WorkspaceFile,
} from "@symnav/core";

import { TypeScriptBackend } from "./typescript-backend.js";
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

    fs.setFile("/repo/src/added.ts", "export const added = 3;\n");
    files = fs.workspaceFiles("src/added.ts", "src/sibling.ts", "src/stable.ts");
    expect(state.refresh(files)).toEqual({ added: 1, changed: 0, removed: 0, unchanged: 2 });
    expect(state.sourceFile("src/stable.ts")).toBe(stableSourceFile);

    fs.deleteFile("/repo/src/added.ts");
    files = fs.workspaceFiles("src/sibling.ts", "src/stable.ts");
    expect(state.refresh(files)).toEqual({ added: 0, changed: 0, removed: 1, unchanged: 2 });
    expect(state.sourceFile("src/stable.ts")).toBe(stableSourceFile);

    fs.deleteFile("/repo/src/sibling.ts");
    fs.setFile("/repo/src/renamed.ts", "export const editedSibling = 2;\n");
    files = fs.workspaceFiles("src/renamed.ts", "src/stable.ts");
    expect(state.refresh(files)).toEqual({ added: 1, changed: 0, removed: 1, unchanged: 1 });
    expect(state.currentFileCount()).toBe(2);
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

  it("adds, removes, and renames files while purging every old lookup", () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/old.ts": "export function oldName(): void {}\n",
    });
    const state = new TypeScriptWorkspaceState(fs);
    const oldIdentity: SymbolIdentity = { file: "src/old.ts", segments: [{ name: "oldName" }] };
    state.refresh(fs.workspaceFiles("src/old.ts"));

    fs.setFile("/repo/src/added.ts", "export const added = true;\n");
    expect(state.refresh(fs.workspaceFiles("src/added.ts", "src/old.ts"))).toEqual({
      added: 1,
      changed: 0,
      removed: 0,
      unchanged: 1,
    });

    fs.deleteFile("/repo/src/old.ts");
    fs.setFile("/repo/src/renamed.ts", "export function renamed(): void {}\n");
    const renamedFiles = fs.workspaceFiles("src/added.ts", "src/renamed.ts");
    expect(state.refresh(renamedFiles)).toEqual({
      added: 1,
      changed: 0,
      removed: 1,
      unchanged: 1,
    });
    expect(state.currentFileCount()).toBe(2);
    expect(state.sourceFile("src/old.ts")).toBeUndefined();
    expect(state.declarationsIn("src/old.ts")).toBeUndefined();
    expect(state.declarationForIdentity(oldIdentity)).toBeUndefined();
    expect(state.locate(oldIdentity)).toEqual([]);
    expect(declarationNames(state, renamedFiles)).toEqual(["added", "renamed"]);
  });

  it("updates declaration, reference, and call lookups after edits and deletion", async () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/lib.ts": "export function oldName(): void {}\n",
      "/repo/src/app.ts": [
        'import { oldName } from "./lib.js";',
        "export function main(): void { oldName(); }",
        "",
      ].join("\n"),
    });
    const state = new TypeScriptWorkspaceState(fs);
    const backend = new TypeScriptBackend(fs, state);
    let files = fs.workspaceFiles("src/app.ts", "src/lib.ts");
    await backend.refresh(files);
    const oldIdentity: SymbolIdentity = { file: "src/lib.ts", segments: [{ name: "oldName" }] };
    expect(await backend.findReferences(files, oldIdentity)).toHaveLength(2);

    fs.setFile("/repo/src/lib.ts", "export function newName(): void {}\n");
    fs.setFile(
      "/repo/src/app.ts",
      [
        'import { newName } from "./lib.js";',
        "export function main(): void { newName(); }",
        "",
      ].join("\n"),
    );
    files = fs.workspaceFiles("src/app.ts", "src/lib.ts");
    await backend.refresh(files);
    const newIdentity: SymbolIdentity = { file: "src/lib.ts", segments: [{ name: "newName" }] };

    expect(await backend.resolveSymbols(files, "oldName", { mode: "exact" })).toEqual([]);
    await expect(backend.findReferences(files, oldIdentity)).rejects.toMatchObject({
      reason: "no symbol src/lib.ts::oldName found",
    });
    expect(await backend.findDefinitions(files, newIdentity)).toHaveLength(1);
    expect(await backend.findReferences(files, newIdentity)).toHaveLength(2);
    expect(
      await backend.findCallees(files, { file: "src/app.ts", segments: [{ name: "main" }] }),
    ).toHaveLength(1);

    fs.deleteFile("/repo/src/lib.ts");
    files = fs.workspaceFiles("src/app.ts");
    await backend.refresh(files);
    expect(await backend.findDefinitions(files, newIdentity)).toEqual([]);
    expect(state.sourceFile("src/lib.ts")).toBeUndefined();
  });

  it("rolls back project mutations and derived state across repeated refresh failures", () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/a.ts": "export const beforeA = 1;\n",
    });
    const state = new TypeScriptWorkspaceState(fs);
    state.refresh(fs.workspaceFiles("src/a.ts"));
    const sourceTextDuringFailure: string[] = [];
    const beforeIdentity: SymbolIdentity = {
      file: "src/a.ts",
      segments: [{ name: "beforeA" }],
    };
    const afterIdentity: SymbolIdentity = {
      file: "src/a.ts",
      segments: [{ name: "afterA" }],
    };
    const addedIdentity: SymbolIdentity = {
      file: "src/b.ts",
      segments: [{ name: "addedB" }],
    };

    fs.setFile("/repo/src/a.ts", "export const afterA = 2;\n");
    fs.setFile("/repo/src/b.ts", "export const addedB = 2;\n");
    fs.failReadsFor("/repo/src/b.ts", () => {
      sourceTextDuringFailure.push(state.sourceFile("src/a.ts")?.getFullText() ?? "");
    });
    const changedFiles = fs.workspaceFiles("src/a.ts", "src/b.ts");

    expect(() => state.refresh(changedFiles)).toThrow("read failed: /repo/src/b.ts");
    expect(sourceTextDuringFailure).toEqual(["export const afterA = 2;\n"]);
    expect(state.sourceFile("src/a.ts")?.getFullText()).toBe("export const beforeA = 1;\n");
    expect(state.declarationsIn("src/a.ts")?.map((entry) => entry.identity)).toEqual([
      beforeIdentity,
    ]);
    expect(state.declarationForIdentity(beforeIdentity)).toBeDefined();
    expect(state.declarationForIdentity(afterIdentity)).toBeUndefined();
    expect(state.locate(beforeIdentity)).toHaveLength(1);
    expect(state.currentFileCount()).toBe(1);
    expect(state.sourceFile("src/b.ts")).toBeUndefined();
    expect(state.declarationsIn("src/b.ts")).toBeUndefined();
    expect(state.declarationForIdentity(addedIdentity)).toBeUndefined();

    expect(() => state.refresh(changedFiles)).toThrow("read failed: /repo/src/b.ts");
    expect(sourceTextDuringFailure).toEqual([
      "export const afterA = 2;\n",
      "export const afterA = 2;\n",
    ]);
    expect(state.sourceFile("src/a.ts")?.getFullText()).toBe("export const beforeA = 1;\n");
    expect(state.declarationsIn("src/a.ts")?.map((entry) => entry.identity)).toEqual([
      beforeIdentity,
    ]);
    expect(state.declarationForIdentity(beforeIdentity)).toBeDefined();
    expect(state.declarationForIdentity(afterIdentity)).toBeUndefined();
    expect(state.locate(beforeIdentity)).toHaveLength(1);
    expect(state.currentFileCount()).toBe(1);
    expect(state.sourceFile("src/b.ts")).toBeUndefined();
    expect(state.declarationsIn("src/b.ts")).toBeUndefined();
    expect(state.declarationForIdentity(addedIdentity)).toBeUndefined();

    fs.restoreReadsFor("/repo/src/b.ts");
    expect(state.refresh(changedFiles)).toEqual({ added: 1, changed: 1, removed: 0, unchanged: 0 });
    expect(state.currentFileCount()).toBe(2);
    expect(state.sourceFile("src/a.ts")?.getFullText()).toBe("export const afterA = 2;\n");
    expect(state.sourceFile("src/b.ts")?.getFullText()).toBe("export const addedB = 2;\n");
    expect(declarationNames(state, changedFiles)).toEqual(["afterA", "addedB"]);
    expect(state.declarationForIdentity(beforeIdentity)).toBeUndefined();
    expect(state.declarationForIdentity(afterIdentity)).toBeDefined();
    expect(state.declarationForIdentity(addedIdentity)).toBeDefined();
  });

  it("keeps old content when a write preserves both modification time and size", () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/a.ts": "export const before = 1;\n",
    });
    const state = new TypeScriptWorkspaceState(fs);
    const files = fs.workspaceFiles("src/a.ts");
    state.refresh(files);
    const metadata = files[0]!.metadata;

    fs.setFile("/repo/src/a.ts", "export const afterx = 2;\n", metadata);
    const sameRevision = fs.workspaceFiles("src/a.ts");

    expect(state.refresh(sameRevision)).toEqual({ added: 0, changed: 0, removed: 0, unchanged: 1 });
    expect(declarationNames(state, sameRevision)).toEqual(["before"]);
  });
});
