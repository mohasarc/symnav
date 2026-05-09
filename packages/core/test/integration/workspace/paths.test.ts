import { describe, expect, it } from "vitest";
import { InMemoryWorkspace } from "../../helpers/in-memory-workspace.js";

describe("Windows-shaped paths", () => {
  it("resolves Windows-shaped startDir through the workspace", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "C:/repo/.git/HEAD": "ref: refs/heads/main\n",
        "C:/repo/.gitignore": "dist/\n",
        "C:/repo/src/x.ts": "",
        "C:/repo/dist/x.js": "",
      },
      startDir: "C:\\repo\\src",
    });
    expect(ws.root).toBe("C:/repo");
    expect(ws.toRelative("C:\\repo\\src\\x.ts")).toBe("src/x.ts");
    expect(ws.toAbsolute("src/x.ts")).toBe("C:/repo/src/x.ts");
    expect(ws.isInWorkspace("C:\\repo\\src\\x.ts")).toBe(true);
    expect(ws.isInWorkspace("C:\\other\\x.ts")).toBe(false);
    expect(ws.isIgnored("dist/x.js")).toBe(true);
  });

  it("rejects UNC paths with a clear error", async () => {
    await expect(
      InMemoryWorkspace.create({
        files: { "//server/share/.git/HEAD": "" },
        startDir: "\\\\server\\share",
      }),
    ).rejects.toThrow(/UNC/i);
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
