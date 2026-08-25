import { describe, expect, it } from "vitest";
import { createWorkspace } from "../../../src/workspace/workspace.js";
import { InMemoryFileSystem } from "../../../src/workspace/in-memory/in-memory-file-system.js";
import { UnreadableDirectoryWarningCandidateError } from "../../../src/workspace/errors.js";

describe("Workspace.enumerate", () => {
  it("returns every non-ignored file under the workspace root with metadata", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/a.ts": "export const a = 1;",
        "/repo/src/nested/b.ts": "export const b = 2;",
        "/repo/README.md": "# repo\n",
      }),
    });
    const files = await ws.enumerate();
    expect(files).toEqual([
      {
        relative: "README.md",
        absolute: "/repo/README.md",
        metadata: expect.objectContaining({ size: 7, modifiedAtMs: 0 }),
      },
      {
        relative: "src/a.ts",
        absolute: "/repo/src/a.ts",
        metadata: expect.objectContaining({ size: 19, modifiedAtMs: 0 }),
      },
      {
        relative: "src/nested/b.ts",
        absolute: "/repo/src/nested/b.ts",
        metadata: expect.objectContaining({ size: 19, modifiedAtMs: 0 }),
      },
    ]);
  });

  it("skips files matched by .gitignore", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "build/\nsecret.ts\n",
        "/repo/src/a.ts": "export const a = 1;",
        "/repo/build/out.ts": "export const out = 0;",
        "/repo/secret.ts": "export const s = 0;",
      }),
    });
    const files = await ws.enumerate();
    const relatives = files.map((f) => f.relative);
    expect(relatives).not.toContain("build/out.ts");
    expect(relatives).not.toContain("secret.ts");
    expect(relatives).toContain("src/a.ts");
  });

  it("skips files under .git/", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.git/config": "[core]\n",
        "/repo/src/a.ts": "export const a = 1;",
      }),
    });
    const files = await ws.enumerate();
    const relatives = files.map((f) => f.relative);
    expect(relatives).not.toContain(".git/HEAD");
    expect(relatives).not.toContain(".git/config");
    expect(relatives).toEqual(["src/a.ts"]);
  });

  it("returns paths sorted by workspace-relative POSIX path", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/zeta.ts": "",
        "/repo/alpha.ts": "",
        "/repo/src/beta.ts": "",
        "/repo/src/aardvark.ts": "",
      }),
    });
    const files = await ws.enumerate();
    expect(files.map((f) => f.relative)).toEqual([
      "alpha.ts",
      "src/aardvark.ts",
      "src/beta.ts",
      "zeta.ts",
    ]);
  });

  it("throws a warning-candidate error (preserving the cause) when a directory cannot be read", async () => {
    const cause = Object.assign(new Error("denied"), { code: "EACCES" });
    class UnreadableSubdirFs extends InMemoryFileSystem {
      unreadableDirectoryReads = 0;

      override async listDir(absPath: string): Promise<readonly string[]> {
        if (absPath === "/repo/src") {
          this.unreadableDirectoryReads += 1;
          throw cause;
        }
        return super.listDir(absPath);
      }
    }
    const fs = new UnreadableSubdirFs({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "",
    });
    const ws = await createWorkspace({
      startDir: "/repo",
      fs,
    });
    expect(await ws.snapshot()).toEqual({ root: "/repo", files: [] });
    const error = await ws.enumerate().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(UnreadableDirectoryWarningCandidateError);
    expect((error as UnreadableDirectoryWarningCandidateError).reason).toContain(
      "warning candidate",
    );
    expect((error as Error).cause).toBe(cause);
    expect(fs.unreadableDirectoryReads).toBe(1);
  });

  it("surfaces unexpected directory failures during active snapshot traversal", async () => {
    const cause = Object.assign(new Error("device failure"), { code: "EIO" });
    class UnexpectedSubdirFailureFileSystem extends InMemoryFileSystem {
      override async listDir(absPath: string): Promise<readonly string[]> {
        if (absPath === "/repo/src") {
          throw cause;
        }
        return super.listDir(absPath);
      }
    }
    const workspace = await createWorkspace({
      startDir: "/repo",
      fs: new UnexpectedSubdirFailureFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/a.ts": "",
      }),
    });

    await expect(workspace.snapshot()).rejects.toBe(cause);
  });

  it("returns the same order on repeated calls", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/c.ts": "",
        "/repo/a.ts": "",
        "/repo/b.ts": "",
      }),
    });
    const first = await ws.enumerate();
    const second = await ws.enumerate();
    expect(second).toEqual(first);
  });

  it("stops at nested Git workspace boundaries before ignore matching or descent", async () => {
    class NestedBoundaryFileSystem extends InMemoryFileSystem {
      readonly nestedDescendantReads: string[] = [];

      override async listDir(absPath: string): Promise<readonly string[]> {
        if (absPath.startsWith("/repo/vendor/package/src")) {
          this.nestedDescendantReads.push(absPath);
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return super.listDir(absPath);
      }
    }

    const fs = new NestedBoundaryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "vendor/\n!vendor/\n!vendor/**\n",
      "/repo/src/root.ts": "export const root = true;\n",
      "/repo/vendor/package/.git/HEAD": "ref: refs/heads/nested\n",
      "/repo/vendor/package/src/unreadable.ts": "export const nested = true;\n",
      "/repo/submodule/.git": "gitdir: ../.git/modules/submodule\n",
      "/repo/submodule/src/submodule.ts": "export const submodule = true;\n",
      "/repo/.worktrees/ordinary/src/ordinary.ts": "export const ordinary = true;\n",
    });
    const ws = await createWorkspace({ startDir: "/repo", fs });

    const sourcePaths = (await ws.enumerate())
      .map((file) => file.relative)
      .filter((path) => path.endsWith(".ts"));

    expect(sourcePaths).toEqual([".worktrees/ordinary/src/ordinary.ts", "src/root.ts"]);
    expect(fs.nestedDescendantReads).toEqual([]);
  });
});
