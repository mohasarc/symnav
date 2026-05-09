import { describe, expect, it } from "vitest";
import { NotInWorkspaceError, createWorkspace } from "@symnav/core";
import { InMemoryFileSystem, InMemoryWorkspace } from "../helpers/in-memory-workspace.js";

describe("Workspace root detection", () => {
  it("finds the nearest .git ancestor", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/pkg/sub/x.ts": "export const x = 1;\n",
      },
      startDir: "/repo/pkg/sub",
    });
    expect(ws.root).toBe("/repo");
  });

  it("treats a .git regular file (submodule layout) the same as a directory", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git": "gitdir: ../.git/modules/repo\n",
        "/repo/pkg/x.ts": "export {};\n",
      },
      startDir: "/repo/pkg",
    });
    expect(ws.root).toBe("/repo");
  });

  it("rejects with NotInWorkspaceError when no .git ancestor exists", async () => {
    await expect(
      InMemoryWorkspace.create({
        files: {
          "/elsewhere/x.ts": "export {};\n",
        },
        startDir: "/elsewhere",
      }),
    ).rejects.toBeInstanceOf(NotInWorkspaceError);
  });
});

describe("Workspace path helpers", () => {
  it("toRelative and toAbsolute round-trip via POSIX paths", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/pkg/sub/file.ts": "",
      },
      startDir: "/repo",
    });
    const abs = "/repo/pkg/sub/file.ts";
    const rel = ws.toRelative(abs);
    expect(rel).toBe("pkg/sub/file.ts");
    expect(ws.toAbsolute(rel)).toBe(abs);
  });

  it("isInWorkspace rejects paths above root and sibling-of-root paths", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/x.ts": "",
        "/repo-other/x.ts": "",
        "/other.ts": "",
      },
      startDir: "/repo",
    });
    expect(ws.isInWorkspace("/repo/x.ts")).toBe(true);
    expect(ws.isInWorkspace("/repo-other/x.ts")).toBe(false);
    expect(ws.isInWorkspace("/repo/../other.ts")).toBe(false);
  });
});

describe("Workspace filesystem", () => {
  it("fs.readFile reads files placed in the in-memory map", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/hello.txt": "Hello, world!\n",
      },
      startDir: "/repo",
    });
    await expect(ws.fs.readFile("/repo/hello.txt")).resolves.toBe("Hello, world!\n");
  });
});

describe("Workspace.isIgnored", () => {
  it("honors a single root .gitignore", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "dist/\n",
        "/repo/dist/x.js": "",
        "/repo/src/x.ts": "",
      },
      startDir: "/repo",
    });
    expect(ws.isIgnored("dist/x.js")).toBe(true);
    expect(ws.isIgnored("src/x.ts")).toBe(false);
  });

  it("aggregates subdirectory .gitignore files", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "",
        "/repo/pkg/.gitignore": "temp.ts\n",
        "/repo/pkg/temp.ts": "",
        "/repo/temp.ts": "",
      },
      startDir: "/repo",
    });
    expect(ws.isIgnored("pkg/temp.ts")).toBe(true);
    expect(ws.isIgnored("temp.ts")).toBe(false);
  });

  it("anchors sub-.gitignore patterns with internal slashes to that subdirectory", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/pkg/.gitignore": "build/output\n",
        "/repo/pkg/build/output/x.js": "",
        "/repo/pkg/sub/build/output/x.js": "",
      },
      startDir: "/repo",
    });
    expect(ws.isIgnored("pkg/build/output/x.js")).toBe(true);
    expect(ws.isIgnored("pkg/sub/build/output/x.js")).toBe(false);
  });

  it("honors negation", async () => {
    // gitignore(5): wholesale `dist/` cannot be re-included — list contents (`dist/*`) to allow `!`.
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "dist/*\n!dist/keep.js\n",
        "/repo/dist/keep.js": "",
        "/repo/dist/other.js": "",
      },
      startDir: "/repo",
    });
    expect(ws.isIgnored("dist/keep.js")).toBe(false);
    expect(ws.isIgnored("dist/other.js")).toBe(true);
  });

  it("always rejects .git/ and any path under it", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "",
      },
      startDir: "/repo",
    });
    expect(ws.isIgnored(".git")).toBe(true);
    expect(ws.isIgnored(".git/HEAD")).toBe(true);
    expect(ws.isIgnored(".git/refs/heads/main")).toBe(true);
  });

  it("skips walking into ignored directories during workspace construction", async () => {
    const listed: string[] = [];
    class TrackingFs extends InMemoryFileSystem {
      override listDirSync(absPath: string): readonly string[] {
        listed.push(absPath);
        return super.listDirSync(absPath);
      }
    }
    const fs = new TrackingFs({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "node_modules/\n",
      "/repo/node_modules/foo/index.js": "",
      "/repo/src/x.ts": "",
    });
    await createWorkspace({ startDir: "/repo", fs });
    expect(listed).not.toContain("/repo/node_modules");
    expect(listed).toContain("/repo/src");
  });

  it("returns false for everything (except .git/) when no .gitignore exists", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "",
        "/repo/dist/x.js": "",
      },
      startDir: "/repo",
    });
    expect(ws.isIgnored("src/x.ts")).toBe(false);
    expect(ws.isIgnored("dist/x.js")).toBe(false);
    expect(ws.isIgnored(".git/HEAD")).toBe(true);
  });
});
