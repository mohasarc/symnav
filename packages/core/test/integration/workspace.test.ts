import { describe, expect, it } from "vitest";
import { NotInWorkspaceError } from "@symnav/core";
import { inMemoryWorkspace } from "@symnav/testing";

describe("Workspace root detection", () => {
  it("finds the nearest .git ancestor directory", async () => {
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/pkg/sub/x.ts": "export const x = 1;",
      },
      startDir: "/repo/pkg/sub",
    });
    expect(ws.root).toBe("/repo");
  });

  it("treats a .git file (submodule layout) the same as a directory", async () => {
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git": "gitdir: ../.git/modules/repo\n",
        "/repo/x.ts": "export const x = 1;",
      },
      startDir: "/repo",
    });
    expect(ws.root).toBe("/repo");
  });

  it("throws NotInWorkspaceError when no .git ancestor exists", async () => {
    await expect(
      inMemoryWorkspace({
        files: { "/somewhere/x.ts": "export const x = 1;" },
        startDir: "/somewhere",
      }),
    ).rejects.toBeInstanceOf(NotInWorkspaceError);
  });
});

describe("Workspace path helpers", () => {
  it("toRelative and toAbsolute round-trip via POSIX paths", async () => {
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "",
        "/repo/pkg/sub/x.ts": "",
      },
      startDir: "/repo",
    });
    const abs = "/repo/pkg/sub/x.ts";
    const rel = ws.toRelative(abs);
    expect(rel).toBe("pkg/sub/x.ts");
    expect(ws.toAbsolute(rel)).toBe(abs);
  });

  it("isInWorkspace rejects paths above root and sibling-of-root paths", async () => {
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "",
        "/repo/x.ts": "",
        "/repo-other/x.ts": "",
      },
      startDir: "/repo",
    });
    expect(ws.isInWorkspace("/repo-other/x.ts")).toBe(false);
    expect(ws.isInWorkspace("/repo/../other.ts")).toBe(false);
    expect(ws.isInWorkspace("/repo/x.ts")).toBe(true);
  });
});

describe("Workspace.isIgnored", () => {
  it("honors a single root .gitignore", async () => {
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "",
        "/repo/.gitignore": "dist/\n",
        "/repo/src/x.ts": "",
        "/repo/dist/x.js": "",
      },
      startDir: "/repo",
    });
    expect(ws.isIgnored("dist/x.js")).toBe(true);
    expect(ws.isIgnored("src/x.ts")).toBe(false);
  });

  it("aggregates subdirectory .gitignore files", async () => {
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "",
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

  it("honors negation patterns", async () => {
    // Note: gitignore semantics forbid re-including files under an ignored
    // directory — `dir/` followed by `!dir/keep.js` does not work. Negation
    // requires the parent rule to leave the directory traversable, e.g. `dir/*`.
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "",
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
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "",
        "/repo/x.ts": "",
      },
      startDir: "/repo",
    });
    expect(ws.isIgnored(".git")).toBe(true);
    expect(ws.isIgnored(".git/HEAD")).toBe(true);
    expect(ws.isIgnored(".git/objects/abc")).toBe(true);
  });

  it("returns false for everything except .git/ when there are no .gitignore files", async () => {
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "",
        "/repo/x.ts": "",
        "/repo/pkg/y.ts": "",
      },
      startDir: "/repo",
    });
    expect(ws.isIgnored("x.ts")).toBe(false);
    expect(ws.isIgnored("pkg/y.ts")).toBe(false);
    expect(ws.isIgnored(".git/HEAD")).toBe(true);
  });
});

describe("WorkspaceFileSystem reads", () => {
  it("readFile returns the contents stored in the in-memory map", async () => {
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "",
        "/repo/note.txt": "hello, world",
      },
      startDir: "/repo",
    });
    expect(await ws.fs.readFile("/repo/note.txt")).toBe("hello, world");
  });
});
