import { describe, expect, it } from "vitest";
import { InMemoryWorkspace, NotInWorkspaceError } from "@symnav/core";

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
