import { describe, expect, it } from "vitest";
import { createWorkspace, InMemoryFileSystem } from "@symnav/core";

describe("Workspace root detection", () => {
  it("finds the nearest .git ancestor", async () => {
    const ws = await createWorkspace({
      startDir: "/repo/pkg/sub",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/pkg/sub/x.ts": "export const x = 1;\n",
      }),
    });
    expect(ws.root).toBe("/repo");
  });

  it("treats a .git regular file (submodule layout) the same as a directory", async () => {
    const ws = await createWorkspace({
      startDir: "/repo/pkg",
      fs: new InMemoryFileSystem({
        "/repo/.git": "gitdir: ../.git/modules/repo\n",
        "/repo/pkg/x.ts": "export {};\n",
      }),
    });
    expect(ws.root).toBe("/repo");
  });

  it("rejects with a UserFacingError when no .git ancestor exists", async () => {
    await expect(
      createWorkspace({
        startDir: "/elsewhere",
        fs: new InMemoryFileSystem({
          "/elsewhere/x.ts": "export {};\n",
        }),
      }),
    ).rejects.toMatchObject({
      reason: "not in a git workspace (no .git found in or above /elsewhere)",
    });
  });
});
