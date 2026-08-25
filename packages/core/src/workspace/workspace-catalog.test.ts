import { describe, expect, it } from "vitest";

import type { FileMetadata, FileSystem } from "./file-system.js";
import { InMemoryFileSystem } from "./in-memory/in-memory-file-system.js";
import { WorkspaceCatalog } from "./workspace-catalog.js";

class MutableCatalogFileSystem implements FileSystem {
  readonly directoryReads: string[] = [];
  readonly metadataReads: string[] = [];
  readonly sourceReads: string[] = [];
  private readonly files = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly modifiedAt = new Map<string, number>();
  private failingDirectory: string | undefined;
  private failingSource: string | undefined;

  constructor(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) this.setFile(path, content);
  }

  setFile(path: string, content: string, modifiedAtMs?: number): void {
    this.files.set(path, content);
    this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1);
    this.modifiedAt.set(path, modifiedAtMs ?? (this.modifiedAt.get(path) ?? 0) + 1);
  }

  deleteFile(path: string): void {
    this.files.delete(path);
    this.revisions.delete(path);
    this.modifiedAt.delete(path);
  }

  failDirectory(path: string): void {
    this.failingDirectory = path;
  }

  restoreDirectories(): void {
    this.failingDirectory = undefined;
  }

  failSource(path: string): void {
    this.failingSource = path;
  }

  restoreSources(): void {
    this.failingSource = undefined;
  }

  resetCounts(): void {
    this.directoryReads.length = 0;
    this.metadataReads.length = 0;
    this.sourceReads.length = 0;
  }

  readFile(absPath: string): Promise<string> {
    this.sourceReads.push(absPath);
    if (absPath === this.failingSource) return Promise.reject(new Error("EIO"));
    return Promise.resolve(this.readFileSync(absPath));
  }

  exists(absPath: string): Promise<boolean> {
    return Promise.resolve(this.existsSync(absPath));
  }

  listDir(absPath: string): Promise<readonly string[]> {
    this.directoryReads.push(absPath);
    if (absPath === this.failingDirectory) return Promise.reject(new Error("EIO"));
    return Promise.resolve(this.listDirSync(absPath));
  }

  isDirectory(absPath: string): Promise<boolean> {
    return Promise.resolve(this.isDirectorySync(absPath));
  }

  metadata(absPath: string): Promise<FileMetadata> {
    this.metadataReads.push(absPath);
    return Promise.resolve(this.metadataSync(absPath));
  }

  existsSync(absPath: string): boolean {
    return this.delegate().existsSync(absPath);
  }

  readFileSync(absPath: string): string {
    const content = this.files.get(absPath);
    if (content === undefined) throw new Error(`ENOENT: ${absPath}`);
    return content;
  }

  listDirSync(absPath: string): readonly string[] {
    return this.delegate().listDirSync(absPath);
  }

  isDirectorySync(absPath: string): boolean {
    return this.delegate().isDirectorySync(absPath);
  }

  metadataSync(absPath: string): FileMetadata {
    if (this.isDirectorySync(absPath)) {
      const entries = this.listDirSync(absPath);
      return {
        size: entries.length,
        modifiedAtMs: 0,
        changeToken: entries.join("\0"),
        fileIdentity: absPath,
      };
    }
    const content = this.readFileSync(absPath);
    return {
      size: Buffer.byteLength(content),
      modifiedAtMs: this.modifiedAt.get(absPath) ?? 0,
      changeToken: String(this.revisions.get(absPath)),
      fileIdentity: absPath,
    };
  }

  private delegate(): InMemoryFileSystem {
    return new InMemoryFileSystem(Object.fromEntries(this.files));
  }
}

function paths(workspace: Awaited<ReturnType<WorkspaceCatalog["refresh"]>>): Promise<string[]> {
  return workspace.snapshot().then((snapshot) => snapshot.files.map((file) => file.relative));
}

describe("WorkspaceCatalog", () => {
  it("publishes immutable turns across file, ignore, and nested-boundary mutations", async () => {
    const fileSystem = new MutableCatalogFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "ignored.ts\n",
      "/repo/src/a.ts": "export const a = 1;\n",
      "/repo/ignored.ts": "export const ignored = 1;\n",
    });
    const catalog = new WorkspaceCatalog(fileSystem);
    const first = await catalog.refresh("/repo");
    const firstSnapshot = await first.snapshot();

    fileSystem.setFile("/repo/src/a.ts", "export const a = 2;\n", 1);
    const edited = await catalog.refresh("/repo");
    expect(
      (await edited.snapshot()).files.find((file) => file.relative === "src/a.ts")?.metadata
        .changeToken,
    ).not.toBe(
      firstSnapshot.files.find((file) => file.relative === "src/a.ts")?.metadata.changeToken,
    );

    fileSystem.setFile("/repo/src/b.ts", "export const b = 1;\n");
    expect(await paths(await catalog.refresh("/repo"))).toEqual([
      ".gitignore",
      "src/a.ts",
      "src/b.ts",
    ]);

    fileSystem.deleteFile("/repo/src/a.ts");
    fileSystem.setFile("/repo/src/renamed.ts", "export const a = 2;\n");
    expect(await paths(await catalog.refresh("/repo"))).toEqual([
      ".gitignore",
      "src/b.ts",
      "src/renamed.ts",
    ]);

    fileSystem.setFile("/repo/.gitignore", "src/b.ts\n");
    expect(await paths(await catalog.refresh("/repo"))).toEqual([
      ".gitignore",
      "ignored.ts",
      "src/renamed.ts",
    ]);

    fileSystem.deleteFile("/repo/.gitignore");
    expect(await paths(await catalog.refresh("/repo"))).toEqual([
      "ignored.ts",
      "src/b.ts",
      "src/renamed.ts",
    ]);

    fileSystem.setFile("/repo/src/.git", "gitdir: elsewhere\n");
    expect(await paths(await catalog.refresh("/repo"))).toEqual(["ignored.ts"]);
    fileSystem.deleteFile("/repo/src/.git");
    expect(await paths(await catalog.refresh("/repo"))).toEqual([
      "ignored.ts",
      "src/b.ts",
      "src/renamed.ts",
    ]);

    expect(firstSnapshot.files.map((file) => file.relative)).toEqual([".gitignore", "src/a.ts"]);
    expect((await first.snapshot()).files).toBe(firstSnapshot.files);
  });

  it("reuses unchanged directory entries and relists only a changed subtree", async () => {
    const fileSystem = new MutableCatalogFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const a = 1;\n",
      "/repo/test/b.ts": "export const b = 1;\n",
    });
    const catalog = new WorkspaceCatalog(fileSystem);
    await catalog.refresh("/repo");

    fileSystem.resetCounts();
    await catalog.refresh("/repo");
    expect(fileSystem.directoryReads).toEqual([]);
    expect(fileSystem.sourceReads).toEqual([]);

    fileSystem.setFile("/repo/src/c.ts", "export const c = 1;\n");
    fileSystem.resetCounts();
    await catalog.refresh("/repo");
    expect(fileSystem.directoryReads).toEqual(["/repo/src"]);
  });

  it("retains the last published turn when refresh fails", async () => {
    const fileSystem = new MutableCatalogFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const a = 1;\n",
    });
    const catalog = new WorkspaceCatalog(fileSystem);
    await catalog.refresh("/repo");
    fileSystem.setFile("/repo/src/b.ts", "export const b = 1;\n");
    fileSystem.failDirectory("/repo/src");

    await expect(catalog.refresh("/repo")).rejects.toThrow("EIO");
    expect(await paths(await catalog.open("/repo"))).toEqual(["src/a.ts"]);

    fileSystem.restoreDirectories();
    expect(await paths(await catalog.refresh("/repo"))).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("retains the last published turn when an ignore read fails", async () => {
    const fileSystem = new MutableCatalogFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "ignored.ts\n",
      "/repo/a.ts": "export const a = 1;\n",
      "/repo/ignored.ts": "export const ignored = 1;\n",
    });
    const catalog = new WorkspaceCatalog(fileSystem);
    await catalog.refresh("/repo");
    fileSystem.setFile("/repo/.gitignore", "a.ts\n");
    fileSystem.failSource("/repo/.gitignore");

    await expect(catalog.refresh("/repo")).rejects.toThrow("EIO");
    expect(await paths(await catalog.open("/repo"))).toEqual([".gitignore", "a.ts"]);

    fileSystem.restoreSources();
    expect(await paths(await catalog.refresh("/repo"))).toEqual([".gitignore", "ignored.ts"]);
  });
});
