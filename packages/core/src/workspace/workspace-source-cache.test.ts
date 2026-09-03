import { describe, expect, it } from "vitest";

import type { FileMetadata, FileSystem } from "./file-system.js";
import type { WorkspaceFile, WorkspaceSnapshot } from "./workspace.js";
import { WorkspaceSourceCache } from "./workspace-source-cache.js";

class RecordingFileSystem implements FileSystem {
  readonly calls: string[] = [];
  private readonly contents = new Map<string, string>();

  constructor(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) this.contents.set(path, content);
  }

  setFile(path: string, content: string): void {
    this.contents.set(path, content);
  }

  resetCalls(): void {
    this.calls.length = 0;
  }

  async readFile(absPath: string): Promise<string> {
    this.calls.push(`readFile:${absPath}`);
    return this.content(absPath);
  }

  async exists(absPath: string): Promise<boolean> {
    this.calls.push(`exists:${absPath}`);
    return this.contents.has(absPath);
  }

  async listDir(absPath: string): Promise<readonly string[]> {
    this.calls.push(`listDir:${absPath}`);
    return ["child.ts"];
  }

  async isDirectory(absPath: string): Promise<boolean> {
    this.calls.push(`isDirectory:${absPath}`);
    return absPath.endsWith("/src");
  }

  async metadata(absPath: string): Promise<FileMetadata> {
    this.calls.push(`metadata:${absPath}`);
    return RecordingFileSystem.metadataFor(this.content(absPath));
  }

  existsSync(absPath: string): boolean {
    this.calls.push(`existsSync:${absPath}`);
    return this.contents.has(absPath);
  }

  readFileSync(absPath: string): string {
    this.calls.push(`readFileSync:${absPath}`);
    return this.content(absPath);
  }

  listDirSync(absPath: string): readonly string[] {
    this.calls.push(`listDirSync:${absPath}`);
    return ["child.ts"];
  }

  isDirectorySync(absPath: string): boolean {
    this.calls.push(`isDirectorySync:${absPath}`);
    return absPath.endsWith("/src");
  }

  metadataSync(absPath: string): FileMetadata {
    this.calls.push(`metadataSync:${absPath}`);
    return RecordingFileSystem.metadataFor(this.content(absPath));
  }

  private content(absPath: string): string {
    const content = this.contents.get(absPath);
    if (content === undefined) throw new Error(`missing file: ${absPath}`);
    return content;
  }

  private static metadataFor(content: string): FileMetadata {
    return {
      size: content.length,
      modifiedAtMs: 1,
      changeToken: content,
    };
  }
}

class WorkspaceSnapshotBuilder {
  static snapshot(...files: WorkspaceFile[]): WorkspaceSnapshot {
    return { root: "/repo", files };
  }

  static file(relative: string, absolute: string, changeToken: string): WorkspaceFile {
    return {
      relative,
      absolute,
      metadata: { size: 1, modifiedAtMs: 1, changeToken },
    };
  }
}

describe("WorkspaceSourceCache", () => {
  it("removes omitted revisions and cached contents on every refresh", async () => {
    const fileSystem = new RecordingFileSystem({
      "/repo/src/a.ts": "a-before",
      "/repo/src/b.ts": "b-before",
    });
    const cache = new WorkspaceSourceCache(fileSystem);
    const a = WorkspaceSnapshotBuilder.file("src/a.ts", "/repo/src/a.ts", "a-1");
    const b = WorkspaceSnapshotBuilder.file("src/b.ts", "/repo/src/b.ts", "b-1");
    cache.refresh(WorkspaceSnapshotBuilder.snapshot(a, b));
    await expect(cache.readFile(b.absolute)).resolves.toBe("b-before");
    fileSystem.setFile(b.absolute, "b-after");
    fileSystem.resetCalls();

    cache.refresh(WorkspaceSnapshotBuilder.snapshot(a));

    await expect(cache.readFile(b.absolute)).resolves.toBe("b-after");
    expect(fileSystem.calls).toEqual(["readFile:/repo/src/b.ts"]);
  });

  it("invalidates cached contents after an incoming absolute path change", async () => {
    const fileSystem = new RecordingFileSystem({
      "/repo/src/a.ts": "before",
      "/repo/src/moved-a.ts": "moved",
    });
    const cache = new WorkspaceSourceCache(fileSystem);
    const initialFile = WorkspaceSnapshotBuilder.file("src/a.ts", "/repo/src/a.ts", "a-1");
    cache.refresh(WorkspaceSnapshotBuilder.snapshot(initialFile));
    await expect(cache.readFile(initialFile.absolute)).resolves.toBe("before");
    fileSystem.setFile(initialFile.absolute, "after");
    fileSystem.resetCalls();

    cache.refresh(
      WorkspaceSnapshotBuilder.snapshot(
        WorkspaceSnapshotBuilder.file("src/a.ts", "/repo/src/moved-a.ts", "a-1"),
      ),
    );

    await expect(cache.readFile(initialFile.absolute)).resolves.toBe("after");
    expect(fileSystem.calls).toEqual(["readFile:/repo/src/a.ts"]);
  });

  it("invalidates cached contents after an incoming change token changes", async () => {
    const fileSystem = new RecordingFileSystem({ "/repo/src/a.ts": "before" });
    const cache = new WorkspaceSourceCache(fileSystem);
    const initialFile = WorkspaceSnapshotBuilder.file("src/a.ts", "/repo/src/a.ts", "a-1");
    cache.refresh(WorkspaceSnapshotBuilder.snapshot(initialFile));
    await expect(cache.readFile(initialFile.absolute)).resolves.toBe("before");
    fileSystem.setFile(initialFile.absolute, "after");
    fileSystem.resetCalls();

    cache.refresh(
      WorkspaceSnapshotBuilder.snapshot(
        WorkspaceSnapshotBuilder.file("src/a.ts", "/repo/src/a.ts", "a-2"),
      ),
    );

    await expect(cache.readFile(initialFile.absolute)).resolves.toBe("after");
    expect(fileSystem.calls).toEqual(["readFile:/repo/src/a.ts"]);
  });

  it("retains cached contents for an unchanged incoming revision", async () => {
    const fileSystem = new RecordingFileSystem({ "/repo/src/a.ts": "before" });
    const cache = new WorkspaceSourceCache(fileSystem);
    const file = WorkspaceSnapshotBuilder.file("src/a.ts", "/repo/src/a.ts", "a-1");
    const snapshot = WorkspaceSnapshotBuilder.snapshot(file);
    cache.refresh(snapshot);
    const initialContent = await cache.readFile(file.absolute);
    fileSystem.setFile(file.absolute, "after");
    fileSystem.resetCalls();

    cache.refresh(snapshot);

    expect(await cache.readFile(file.absolute)).toBe(initialContent);
    expect(fileSystem.calls).toEqual([]);
  });
});
