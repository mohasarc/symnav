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
