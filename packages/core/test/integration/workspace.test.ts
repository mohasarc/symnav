import { describe, expect, it } from "vitest";
import { NotInWorkspaceError } from "@symnav/core";
import { inMemoryWorkspace } from "@symnav/testing";

describe("Workspace root detection", () => {
  it("finds the nearest .git ancestor", async () => {
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/pkg/sub/x.ts": "export const x = 1;\n",
      },
      startDir: "/repo/pkg/sub",
    });
    expect(ws.root).toBe("/repo");
  });

  it("treats a .git regular file (submodule layout) the same as a directory", async () => {
    const ws = await inMemoryWorkspace({
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
      inMemoryWorkspace({
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
    const ws = await inMemoryWorkspace({
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
    const ws = await inMemoryWorkspace({
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
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/hello.txt": "Hello, world!\n",
      },
      startDir: "/repo",
    });
    await expect(ws.fs.readFile("/repo/hello.txt")).resolves.toBe("Hello, world!\n");
  });
});
