import { describe, expect, it } from "vitest";

import {
  DirectoryInputError,
  FileNotFoundError,
  IgnoredFileError,
  OutsideWorkspaceError,
} from "./errors.js";
import type { FileMetadata, FileSystem } from "./file-system.js";
import { InMemoryFileSystem } from "./in-memory/in-memory-file-system.js";
import { createWorkspace } from "./workspace.js";

class CountingFileSystem implements FileSystem {
  readonly directoryReads: string[] = [];
  readonly metadataPaths: string[] = [];

  constructor(private readonly inner: InMemoryFileSystem) {}

  readFile(absPath: string): Promise<string> {
    return this.inner.readFile(absPath);
  }

  exists(absPath: string): Promise<boolean> {
    return this.inner.exists(absPath);
  }

  listDir(absPath: string): Promise<readonly string[]> {
    this.directoryReads.push(`async:${absPath}`);
    return this.inner.listDir(absPath);
  }

  isDirectory(absPath: string): Promise<boolean> {
    return this.inner.isDirectory(absPath);
  }

  metadata(absPath: string): Promise<FileMetadata> {
    this.metadataPaths.push(absPath);
    return Promise.resolve({
      size: this.inner.readFileSync(absPath).length,
      modifiedAtMs: 100,
      changeToken: this.inner.metadataSync(absPath).changeToken,
      fileIdentity: absPath,
    });
  }

  existsSync(absPath: string): boolean {
    return this.inner.existsSync(absPath);
  }

  readFileSync(absPath: string): string {
    return this.inner.readFileSync(absPath);
  }

  listDirSync(absPath: string): readonly string[] {
    this.directoryReads.push(`sync:${absPath}`);
    return this.inner.listDirSync(absPath);
  }

  isDirectorySync(absPath: string): boolean {
    return this.inner.isDirectorySync(absPath);
  }

  metadataSync(absPath: string): FileMetadata {
    this.metadataPaths.push(absPath);
    return {
      size: this.inner.readFileSync(absPath).length,
      modifiedAtMs: 100,
      changeToken: this.inner.metadataSync(absPath).changeToken,
      fileIdentity: absPath,
    };
  }
}

function workspaceFileSystem(): CountingFileSystem {
  return new CountingFileSystem(
    new InMemoryFileSystem({
      "/outside.ts": "export const outside = true;\n",
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "ignored.ts\nvendor/\n",
      "/repo/ignored.ts": "export const ignored = true;\n",
      "/repo/src/b.ts": "export const b = true;\n",
      "/repo/src/a.ts": "export const a = true;\n",
      "/repo/src/nested/.gitignore": "skip.ts\n",
      "/repo/src/nested/keep.ts": "export const keep = true;\n",
      "/repo/src/nested/skip.ts": "export const skip = true;\n",
      "/repo/vendor/pkg/index.ts": "export const vendor = true;\n",
    }),
  );
}

class MutableWorkspaceFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();
  private modifiedAtMs = 0;

  constructor(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(path, content);
    }
  }

  setFile(path: string, content: string): void {
    this.files.set(path, content);
    this.modifiedAtMs += 1;
  }

  deleteFile(path: string): void {
    this.files.delete(path);
    this.modifiedAtMs += 1;
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
    const content = this.files.get(absPath);
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
    const content = this.readFileSync(absPath);
    return {
      size: Buffer.byteLength(content),
      modifiedAtMs: this.modifiedAtMs,
      changeToken: `${this.modifiedAtMs}:${content}`,
      fileIdentity: absPath,
    };
  }

  private delegate(): InMemoryFileSystem {
    return new InMemoryFileSystem(Object.fromEntries(this.files));
  }
}

describe("Workspace snapshots", () => {
  it("stats only a selected path without workspace traversal", async () => {
    const fs = workspaceFileSystem();
    const workspace = await createWorkspace({ startDir: "/repo", fs });

    const target = await workspace.resolveInputPath("src/a.ts", "/repo");
    const snapshot = await workspace.snapshot([target]);
    await workspace.resolveInputPath("src/a.ts", "/repo");

    expect(snapshot).toEqual({
      root: "/repo",
      files: [
        {
          relative: "src/a.ts",
          absolute: "/repo/src/a.ts",
          metadata: {
            size: 23,
            modifiedAtMs: 100,
            changeToken: expect.any(String),
            fileIdentity: "/repo/src/a.ts",
          },
        },
      ],
    });
    expect(fs.directoryReads).toEqual([]);
    expect(fs.metadataPaths).toEqual(["/repo/src/a.ts"]);
  });

  it("walks and stats non-ignored files once in sorted order", async () => {
    const fs = workspaceFileSystem();
    const workspace = await createWorkspace({ startDir: "/repo", fs });

    const first = await workspace.snapshot();
    const second = await workspace.snapshot();
    const enumerated = await workspace.enumerate();

    expect(first).toBe(second);
    expect(first.root).toBe("/repo");
    expect(first.files.map((file) => file.relative)).toEqual([
      ".gitignore",
      "src/a.ts",
      "src/b.ts",
      "src/nested/.gitignore",
      "src/nested/keep.ts",
    ]);
    expect(first.files.map((file) => file.metadata)).toEqual([
      expect.objectContaining({ size: 19, modifiedAtMs: 100 }),
      expect.objectContaining({ size: 23, modifiedAtMs: 100 }),
      expect.objectContaining({ size: 23, modifiedAtMs: 100 }),
      expect.objectContaining({ size: 8, modifiedAtMs: 100 }),
      expect.objectContaining({ size: 26, modifiedAtMs: 100 }),
    ]);
    expect(enumerated).toBe(first.files);
    expect(fs.directoryReads).toEqual(["async:/repo", "async:/repo/src", "async:/repo/src/nested"]);
    expect(fs.metadataPaths).toEqual([
      "/repo/.gitignore",
      "/repo/src/a.ts",
      "/repo/src/b.ts",
      "/repo/src/nested/.gitignore",
      "/repo/src/nested/keep.ts",
    ]);
  });

  it("retains input path errors after snapshot creation", async () => {
    const fs = workspaceFileSystem();
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    await workspace.snapshot();

    await expect(workspace.resolveInputPath("missing.ts", "/repo")).rejects.toBeInstanceOf(
      FileNotFoundError,
    );
    await expect(workspace.resolveInputPath("/outside.ts", "/repo")).rejects.toBeInstanceOf(
      OutsideWorkspaceError,
    );
    await expect(workspace.resolveInputPath("ignored.ts", "/repo")).rejects.toBeInstanceOf(
      IgnoredFileError,
    );
    await expect(workspace.resolveInputPath("src", "/repo")).rejects.toBeInstanceOf(
      DirectoryInputError,
    );
  });

  it("keeps one request immutable while new workspaces see ignore and file-set changes", async () => {
    const fs = new MutableWorkspaceFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "ignored.ts\n",
      "/repo/a.ts": "export const a = 1;\n",
      "/repo/ignored.ts": "export const ignored = 1;\n",
    });
    const firstWorkspace = await createWorkspace({ startDir: "/repo", fs });
    const firstSnapshot = await firstWorkspace.snapshot();

    fs.setFile("/repo/.gitignore", "a.ts\n");
    fs.deleteFile("/repo/a.ts");
    fs.setFile("/repo/added.ts", "export const added = 1;\n");
    const secondWorkspace = await createWorkspace({ startDir: "/repo", fs });
    const secondSnapshot = await secondWorkspace.snapshot();

    expect(firstSnapshot.files.map((file) => file.relative)).toEqual([".gitignore", "a.ts"]);
    expect((await firstWorkspace.snapshot()).files).toBe(firstSnapshot.files);
    expect(secondSnapshot.files.map((file) => file.relative)).toEqual([
      ".gitignore",
      "added.ts",
      "ignored.ts",
    ]);
  });
});
