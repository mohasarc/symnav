import { describe, expect, it, vi } from "vitest";
import { Project } from "ts-morph";

import {
  InMemoryFileSystem,
  type FileMetadata,
  type FileSystem,
  type SymbolIdentity,
  type WorkspaceFile,
} from "@symnav/core";

import { TypeScriptBackend } from "./typescript-backend.js";
import * as fileEntryExtraction from "../extract/extract-file-entries.js";
import {
  TypeScriptWorkspaceState,
  type TypeScriptFileExtractionRequest,
  type TypeScriptFileExtractor,
} from "./typescript-workspace-state.js";

class CountingTypeScriptFileExtractor implements TypeScriptFileExtractor {
  readonly calls: string[] = [];
  private readonly failingPaths = new Set<string>();

  failFor(filePath: string): void {
    this.failingPaths.add(filePath);
  }

  restore(filePath: string): void {
    this.failingPaths.delete(filePath);
  }

  extract(request: TypeScriptFileExtractionRequest) {
    this.calls.push(request.filePath);
    if (this.failingPaths.has(request.filePath)) {
      throw new Error(`extraction failed: ${request.filePath}`);
    }
    return fileEntryExtraction.extractFileEntries(request);
  }
}

class MutableWorkspaceFileSystem implements FileSystem {
  private readonly contents = new Map<string, string>();
  private readonly revisions = new Map<string, FileMetadata>();
  private readonly failingReads = new Set<string>();
  private readonly failingReadObservers = new Map<string, () => void>();

  constructor(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      this.setFile(path, content, {
        size: Buffer.byteLength(content),
        modifiedAtMs: 1,
        changeToken: `1:${content}`,
      });
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
        changeToken: `${(previous?.modifiedAtMs ?? 0) + 1}:${content}`,
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

async function declarationNames(
  state: TypeScriptWorkspaceState,
  files: readonly WorkspaceFile[],
): Promise<readonly string[]> {
  return (await state.declarations(files)).map(
    (declaration) => declaration.identity.segments.at(-1)?.name ?? "",
  );
}

describe("TypeScriptWorkspaceState.refresh", () => {
  it("extracts each file revision once across prepared lookups and no-change refresh", async () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/a.ts": "export const before = 1;\n",
    });
    const extractor = new CountingTypeScriptFileExtractor();
    const state = new TypeScriptWorkspaceState(fs, extractor);
    const firstRevision = fs.workspaceFiles("src/a.ts");

    await state.refresh(firstRevision);
    const firstEntries = await state.fileEntries(firstRevision[0]!);
    expect(await state.fileEntries(firstRevision[0]!)).toBe(firstEntries);
    expect(await state.declarations(firstRevision)).toHaveLength(1);
    await state.refresh(firstRevision);
    expect(await state.fileEntries(firstRevision[0]!)).toBe(firstEntries);
    expect(extractor.calls).toEqual(["src/a.ts"]);

    fs.setFile("/repo/src/a.ts", "export const afterx = 2;\n");
    const secondRevision = fs.workspaceFiles("src/a.ts");
    await state.refresh(secondRevision);

    expect(await state.fileEntries(secondRevision[0]!)).not.toBe(firstEntries);
    expect(extractor.calls).toEqual(["src/a.ts", "src/a.ts"]);
  });

  it("reuses prepared declarations across repeated semantic lookups", async () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/app.ts": [
        "export function target(): void {}",
        "export function caller(): void { target(); }",
        "",
      ].join("\n"),
    });
    const extraction = vi.spyOn(fileEntryExtraction, "extractFileEntries");
    const state = new TypeScriptWorkspaceState(fs);
    const backend = new TypeScriptBackend(fs, state);
    const files = fs.workspaceFiles("src/app.ts");
    const target: SymbolIdentity = { file: "src/app.ts", segments: [{ name: "target" }] };
    const caller: SymbolIdentity = { file: "src/app.ts", segments: [{ name: "caller" }] };

    await backend.refresh({ snapshot: { root: "/repo", files }, coverage: "workspace" });
    const preparedTarget = state
      .declarationsIn("src/app.ts")
      ?.find((declaration) => declaration.identity.segments.at(-1)?.name === "target");

    for (let repetition = 0; repetition < 2; repetition += 1) {
      expect(await backend.findDefinitions(files, target)).toHaveLength(1);
      expect(await backend.findReferences(files, target)).toHaveLength(1);
      expect(await backend.findCallees(files, caller)).toHaveLength(1);
      expect(await backend.findCallers(files, target)).toHaveLength(1);
      expect(state.locate(target)[0]?.declaration).toBe(preparedTarget);
    }

    expect(extraction).toHaveBeenCalledTimes(1);
    extraction.mockRestore();
  });

  it("publishes changed declarations and diagnostics only after every extraction succeeds", async () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/a.ts": "export const beforeA = 1;\n@orphaned\n",
      "/repo/src/b.ts": "export const beforeB = 1;\n",
    });
    const extractor = new CountingTypeScriptFileExtractor();
    const state = new TypeScriptWorkspaceState(fs, extractor);
    const beforeFiles = fs.workspaceFiles("src/a.ts", "src/b.ts");
    await state.refresh(beforeFiles);
    const beforeEntries = await state.fileEntries(beforeFiles[0]!);
    const beforeDiagnostics = state.diagnostics(beforeFiles[0]!);

    fs.setFile("/repo/src/a.ts", "export const afterA = 2;\n");
    fs.setFile("/repo/src/b.ts", "export const afterB = 2;\n");
    const afterFiles = fs.workspaceFiles("src/a.ts", "src/b.ts");
    extractor.failFor("src/b.ts");

    await expect(state.refresh(afterFiles)).rejects.toThrow("extraction failed: src/b.ts");
    expect(await state.fileEntries(beforeFiles[0]!)).toBe(beforeEntries);
    expect(state.diagnostics(beforeFiles[0]!)).toBe(beforeDiagnostics);
    expect(await declarationNames(state, beforeFiles)).toEqual(["beforeA", "beforeB"]);

    extractor.restore("src/b.ts");
    await state.refresh(afterFiles);

    expect(await state.fileEntries(afterFiles[0]!)).not.toBe(beforeEntries);
    expect(state.diagnostics(afterFiles[0]!)).toEqual([]);
    expect(await declarationNames(state, afterFiles)).toEqual(["afterA", "afterB"]);
  });

  it("retains unselected diagnostics and purges removed diagnostics", async () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/a.ts": "export const a = 1;\n",
      "/repo/src/b.ts": "export const b = 1;\n@orphaned\n",
    });
    const state = new TypeScriptWorkspaceState(fs);
    const files = fs.workspaceFiles("src/a.ts", "src/b.ts");
    await state.refresh(files);
    const siblingDiagnostics = state.diagnostics(files[1]!);
    const siblingEntries = await state.fileEntries(files[1]!);
    const siblingDeclarations = state.declarationsIn("src/b.ts");
    const siblingSource = state.sourceFile("src/b.ts");

    fs.setFile("/repo/src/a.ts", "export const changedA = 2;\n");
    await state.refresh(fs.workspaceFiles("src/a.ts"), "selection");

    expect(state.diagnostics(files[1]!)).toBe(siblingDiagnostics);
    expect(await state.fileEntries(files[1]!)).toBe(siblingEntries);
    expect(state.declarationsIn("src/b.ts")).toBe(siblingDeclarations);
    expect(state.sourceFile("src/b.ts")).toBe(siblingSource);

    fs.deleteFile("/repo/src/b.ts");
    await state.refresh(fs.workspaceFiles("src/a.ts"));

    expect(state.diagnostics(files[1]!)).toEqual([]);
    expect(state.declarationsIn("src/b.ts")).toBeUndefined();
  });

  it("keeps an unchanged source object while sibling deltas are applied", async () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/stable.ts": "export const stable = 1;\n",
      "/repo/src/sibling.ts": "export const sibling = 1;\n",
    });
    const state = new TypeScriptWorkspaceState(fs);
    let files = fs.workspaceFiles("src/sibling.ts", "src/stable.ts");

    await expect(state.refresh(files)).resolves.toEqual({
      added: 2,
      changed: 0,
      removed: 0,
      unchanged: 0,
    });
    const stableSourceFile = state.sourceFile("src/stable.ts");

    fs.setFile("/repo/src/sibling.ts", "export const editedSibling = 2;\n");
    files = fs.workspaceFiles("src/sibling.ts", "src/stable.ts");
    await expect(state.refresh(files)).resolves.toEqual({
      added: 0,
      changed: 1,
      removed: 0,
      unchanged: 1,
    });
    expect(state.sourceFile("src/stable.ts")).toBe(stableSourceFile);

    fs.setFile("/repo/src/added.ts", "export const added = 3;\n");
    files = fs.workspaceFiles("src/added.ts", "src/sibling.ts", "src/stable.ts");
    await expect(state.refresh(files)).resolves.toEqual({
      added: 1,
      changed: 0,
      removed: 0,
      unchanged: 2,
    });
    expect(state.sourceFile("src/stable.ts")).toBe(stableSourceFile);

    fs.deleteFile("/repo/src/added.ts");
    files = fs.workspaceFiles("src/sibling.ts", "src/stable.ts");
    await expect(state.refresh(files)).resolves.toEqual({
      added: 0,
      changed: 0,
      removed: 1,
      unchanged: 2,
    });
    expect(state.sourceFile("src/stable.ts")).toBe(stableSourceFile);

    fs.deleteFile("/repo/src/sibling.ts");
    fs.setFile("/repo/src/renamed.ts", "export const editedSibling = 2;\n");
    files = fs.workspaceFiles("src/renamed.ts", "src/stable.ts");
    await expect(state.refresh(files)).resolves.toEqual({
      added: 1,
      changed: 0,
      removed: 1,
      unchanged: 1,
    });
    expect(state.currentFileCount()).toBe(2);
    expect(state.sourceFile("src/stable.ts")).toBe(stableSourceFile);
  });

  it.each([
    {
      trigger: "size only",
      source: "export const longerName = 1;\n",
      metadata: { size: 29, modifiedAtMs: 1, changeToken: "revision-1" },
      expectedName: "longerName",
    },
    {
      trigger: "modification time only",
      source: "export const b = 2;\n",
      metadata: { size: 20, modifiedAtMs: 2, changeToken: "revision-2" },
      expectedName: "b",
    },
  ])(
    "reloads and reindexes one file after a $trigger change",
    async ({ source, metadata, expectedName }) => {
      const fs = new MutableWorkspaceFileSystem({
        "/repo/src/a.ts": "export const a = 1;\n",
      });
      const state = new TypeScriptWorkspaceState(fs);
      await state.refresh(fs.workspaceFiles("src/a.ts"));

      fs.setFile("/repo/src/a.ts", source, metadata);
      const files = fs.workspaceFiles("src/a.ts");

      await expect(state.refresh(files)).resolves.toEqual({
        added: 0,
        changed: 1,
        removed: 0,
        unchanged: 0,
      });
      expect(await declarationNames(state, files)).toEqual([expectedName]);
    },
  );

  it("adds, removes, and renames files while purging every old lookup", async () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/old.ts": "export function oldName(): void {}\n",
    });
    const state = new TypeScriptWorkspaceState(fs);
    const oldIdentity: SymbolIdentity = { file: "src/old.ts", segments: [{ name: "oldName" }] };
    await state.refresh(fs.workspaceFiles("src/old.ts"));

    fs.setFile("/repo/src/added.ts", "export const added = true;\n");
    await expect(state.refresh(fs.workspaceFiles("src/added.ts", "src/old.ts"))).resolves.toEqual({
      added: 1,
      changed: 0,
      removed: 0,
      unchanged: 1,
    });

    fs.deleteFile("/repo/src/old.ts");
    fs.setFile("/repo/src/renamed.ts", "export function renamed(): void {}\n");
    const renamedFiles = fs.workspaceFiles("src/added.ts", "src/renamed.ts");
    await expect(state.refresh(renamedFiles)).resolves.toEqual({
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
    expect(await declarationNames(state, renamedFiles)).toEqual(["added", "renamed"]);
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
    await backend.refresh({ snapshot: { root: "/repo", files }, coverage: "workspace" });
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
    await backend.refresh({ snapshot: { root: "/repo", files }, coverage: "workspace" });
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
    await backend.refresh({ snapshot: { root: "/repo", files }, coverage: "workspace" });
    expect(await backend.findDefinitions(files, newIdentity)).toEqual([]);
    expect(state.sourceFile("src/lib.ts")).toBeUndefined();
  });

  it("rolls back project mutations and derived state across repeated refresh failures", async () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/a.ts": "export const beforeA = 1;\n",
    });
    const state = new TypeScriptWorkspaceState(fs);
    await state.refresh(fs.workspaceFiles("src/a.ts"));
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

    await expect(state.refresh(changedFiles)).rejects.toThrow("read failed: /repo/src/b.ts");
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

    await expect(state.refresh(changedFiles)).rejects.toThrow("read failed: /repo/src/b.ts");
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
    await expect(state.refresh(changedFiles)).resolves.toEqual({
      added: 1,
      changed: 1,
      removed: 0,
      unchanged: 0,
    });
    expect(state.currentFileCount()).toBe(2);
    expect(state.sourceFile("src/a.ts")?.getFullText()).toBe("export const afterA = 2;\n");
    expect(state.sourceFile("src/b.ts")?.getFullText()).toBe("export const addedB = 2;\n");
    expect(await declarationNames(state, changedFiles)).toEqual(["afterA", "addedB"]);
    expect(state.declarationForIdentity(beforeIdentity)).toBeUndefined();
    expect(state.declarationForIdentity(afterIdentity)).toBeDefined();
    expect(state.declarationForIdentity(addedIdentity)).toBeDefined();
  });

  it("reloads content when only the filesystem change token changes", async () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/a.ts": "export const before = 1;\n",
    });
    const state = new TypeScriptWorkspaceState(fs);
    const files = fs.workspaceFiles("src/a.ts");
    await state.refresh(files);
    const metadata = files[0]!.metadata;

    fs.setFile("/repo/src/a.ts", "export const afterx = 2;\n", {
      ...metadata,
      changeToken: "equal-size-restored-time-edit",
    });
    const changedRevision = fs.workspaceFiles("src/a.ts");

    await expect(state.refresh(changedRevision)).resolves.toEqual({
      added: 0,
      changed: 1,
      removed: 0,
      unchanged: 0,
    });
    expect(await declarationNames(state, changedRevision)).toEqual(["afterx"]);
  });

  it("publishes earlier ensureFiles progress when a later file fails", async () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/a.ts": "export const a = 1;\n",
      "/repo/src/b.ts": "export const b = 1;\n",
    });
    const state = new TypeScriptWorkspaceState(fs);
    fs.failReadsFor("/repo/src/b.ts");

    await expect(
      state.ensureFiles([
        { relative: "src/a.ts", absolute: "/repo/src/a.ts" },
        { relative: "src/b.ts", absolute: "/repo/src/b.ts" },
      ]),
    ).rejects.toThrow("read failed: /repo/src/b.ts");
    expect(state.declarationsIn("src/a.ts")).toBeDefined();
    expect(state.declarationsIn("src/b.ts")).toBeUndefined();
  });

  it("rolls back added and replaced sources in LIFO order", async () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/src/a.ts": "export const beforeA = 1;\n",
      "/repo/src/b.ts": "export const addedB = 1;\n",
      "/repo/src/c.ts": "export const addedC = 1;\n",
    });
    const extractor = new CountingTypeScriptFileExtractor();
    const state = new TypeScriptWorkspaceState(fs, extractor);
    await state.refresh(fs.workspaceFiles("src/a.ts"));
    const beforeA = state.sourceFile("src/a.ts");
    fs.setFile("/repo/src/a.ts", "export const afterA = 2;\n");
    extractor.failFor("src/c.ts");
    const originalRemove = Project.prototype.removeSourceFile;
    const rollbackOrder: string[] = [];
    const removeSpy = vi.spyOn(Project.prototype, "removeSourceFile").mockImplementation(function (
      this: Project,
      sourceFile,
    ) {
      rollbackOrder.push(
        `${sourceFile.getFilePath()}:${state.sourceFile("src/a.ts")?.getFullText()}`,
      );
      return originalRemove.call(this, sourceFile);
    });

    await expect(
      state.refresh(fs.workspaceFiles("src/a.ts", "src/b.ts", "src/c.ts")),
    ).rejects.toThrow("extraction failed: src/c.ts");
    expect(rollbackOrder).toEqual([
      "/repo/src/c.ts:export const afterA = 2;\n",
      "/repo/src/b.ts:export const afterA = 2;\n",
    ]);
    expect(state.sourceFile("src/a.ts")).toBe(beforeA);
    expect(state.sourceFile("src/a.ts")?.getFullText()).toBe("export const beforeA = 1;\n");
    expect(state.sourceFile("src/b.ts")).toBeUndefined();
    expect(state.sourceFile("src/c.ts")).toBeUndefined();

    removeSpy.mockRestore();
  });
});
