import { describe, expect, it } from "vitest";
import { createWorkspace } from "../../../src/workspace/workspace.js";
import { InMemoryFileSystem } from "../../../src/workspace/in-memory/in-memory-file-system.js";
import type { FileMetadata, FileSystem } from "../../../src/workspace/file-system.js";
import {
  DirectoryInputError,
  FileNotFoundError,
  IgnoredFileError,
  NestedWorkspacePathError,
  OutsideWorkspaceError,
} from "../../../src/workspace/errors.js";

describe("Workspace.resolveInputPath", () => {
  it("resolves a relative input against cwd into a workspace-relative POSIX path", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/nested/a.ts": "export const x = 1;",
      }),
    });
    expect(await ws.resolveInputPath("a.ts", "/repo/src/nested")).toEqual({
      relative: "src/nested/a.ts",
      absolute: "/repo/src/nested/a.ts",
    });
  });

  it.each(["C:/repo/src/nested", "C:\\repo\\src\\nested"])(
    "resolves a relative input from drive-qualified cwd %s",
    async (cwd) => {
      const ws = await createWorkspace({
        startDir: "C:/repo",
        fs: new InMemoryFileSystem({
          "C:/repo/.git/HEAD": "ref: refs/heads/main\n",
          "C:/repo/src/nested/a.ts": "export const x = 1;",
        }),
      });

      expect(await ws.resolveInputPath("a.ts", cwd)).toEqual({
        relative: "src/nested/a.ts",
        absolute: "C:/repo/src/nested/a.ts",
      });
    },
  );

  it("returns an absolute input inside the workspace as a workspace-relative path", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/a.ts": "export const x = 1;",
      }),
    });
    expect(await ws.resolveInputPath("/repo/src/a.ts", "/repo")).toEqual({
      relative: "src/a.ts",
      absolute: "/repo/src/a.ts",
    });
  });

  it("throws FileNotFoundError when the resolved path does not exist", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" }),
    });
    await expect(ws.resolveInputPath("src/missing.ts", "/repo")).rejects.toBeInstanceOf(
      FileNotFoundError,
    );
  });

  it("throws OutsideWorkspaceError for a path outside the workspace root", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/other/src/a.ts": "export const x = 1;",
      }),
    });
    await expect(ws.resolveInputPath("/other/src/a.ts", "/repo")).rejects.toBeInstanceOf(
      OutsideWorkspaceError,
    );
  });

  it("throws IgnoredFileError when the path matches an ignore rule", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "build/\n",
        "/repo/build/a.ts": "export const x = 1;",
      }),
    });
    await expect(ws.resolveInputPath("build/a.ts", "/repo")).rejects.toBeInstanceOf(
      IgnoredFileError,
    );
  });

  it("throws DirectoryInputError when the resolved path is a directory", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/rules/index.ts": "export const rule = true;",
      }),
    });
    await expect(ws.resolveInputPath("src/rules", "/repo")).rejects.toBeInstanceOf(
      DirectoryInputError,
    );
  });

  it.each([
    {
      marker: { "/repo/vendor/package/.git/HEAD": "ref: refs/heads/nested\n" },
      nestedRoot: "/repo/vendor/package",
    },
    {
      marker: { "/repo/worktrees/feature/.git": "gitdir: /repo/.git/worktrees/feature\n" },
      nestedRoot: "/repo/worktrees/feature",
    },
  ])(
    "rejects a direct file owned by nested workspace $nestedRoot",
    async ({ marker, nestedRoot }) => {
      const inputPath = `${nestedRoot.slice("/repo/".length)}/src/a.ts`;
      const ws = await createWorkspace({
        startDir: "/repo",
        fs: new InMemoryFileSystem({
          "/repo/.git/HEAD": "ref: refs/heads/main\n",
          "/repo/.gitignore": `${nestedRoot.slice("/repo/".length)}/\n`,
          [`${nestedRoot}/src/a.ts`]: "export const x = 1;\n",
          ...marker,
        }),
      });

      const error = await ws.resolveInputPath(inputPath, "/repo").then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(NestedWorkspacePathError);
      expect(error).toMatchObject({
        inputPath,
        workspaceRoot: "/repo",
        nestedWorkspaceRoot: nestedRoot,
      });
    },
  );

  it("reports nested ownership before rejecting a nested directory input", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/vendor/package/.git/HEAD": "ref: refs/heads/nested\n",
        "/repo/vendor/package/src/a.ts": "export const x = 1;\n",
      }),
    });

    await expect(ws.resolveInputPath("vendor/package/src", "/repo")).rejects.toBeInstanceOf(
      NestedWorkspacePathError,
    );
  });

  it("resolves an ordinary path under a marker-free .worktrees directory", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.worktrees/ordinary/src/a.ts": "export const x = 1;\n",
      }),
    });

    expect(await ws.resolveInputPath(".worktrees/ordinary/src/a.ts", "/repo")).toEqual({
      relative: ".worktrees/ordinary/src/a.ts",
      absolute: "/repo/.worktrees/ordinary/src/a.ts",
    });
  });

  it("validates one target without listing thousands of siblings", async () => {
    const siblingFiles = Object.fromEntries(
      Array.from({ length: 4_000 }, (_, index) => [
        `/repo/siblings/file-${index}.ts`,
        `export const value${index} = ${index};\n`,
      ]),
    );
    const fileSystem = new TargetCountingFileSystem(
      new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "generated/\n",
        "/repo/src/.gitignore": "ignored.ts\n",
        "/repo/src/target.ts": "export const target = true;\n",
        ...siblingFiles,
      }),
    );
    const workspace = await createWorkspace({ startDir: "/repo", fs: fileSystem });

    await expect(workspace.resolveInputPath("src/target.ts", "/repo")).resolves.toEqual({
      relative: "src/target.ts",
      absolute: "/repo/src/target.ts",
    });
    expect(fileSystem.directoryReads).toEqual([]);
    expect(fileSystem.sourceReads).toEqual(["/repo/.gitignore", "/repo/src/.gitignore"]);
  });
});

class TargetCountingFileSystem implements FileSystem {
  readonly directoryReads: string[] = [];
  readonly sourceReads: string[] = [];

  constructor(private readonly inner: InMemoryFileSystem) {}

  readFile(absPath: string): Promise<string> {
    this.sourceReads.push(absPath);
    return this.inner.readFile(absPath);
  }

  exists(absPath: string): Promise<boolean> {
    return this.inner.exists(absPath);
  }

  listDir(absPath: string): Promise<readonly string[]> {
    this.directoryReads.push(absPath);
    return this.inner.listDir(absPath);
  }

  isDirectory(absPath: string): Promise<boolean> {
    return this.inner.isDirectory(absPath);
  }

  metadata(absPath: string): Promise<FileMetadata> {
    return this.inner.metadata(absPath);
  }

  existsSync(absPath: string): boolean {
    return this.inner.existsSync(absPath);
  }

  readFileSync(absPath: string): string {
    return this.inner.readFileSync(absPath);
  }

  listDirSync(absPath: string): readonly string[] {
    this.directoryReads.push(absPath);
    return this.inner.listDirSync(absPath);
  }

  isDirectorySync(absPath: string): boolean {
    return this.inner.isDirectorySync(absPath);
  }

  metadataSync(absPath: string): FileMetadata {
    return this.inner.metadataSync(absPath);
  }
}
