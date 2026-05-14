import { describe, expect, it } from "vitest";
import { createWorkspace } from "../../../src/workspace/workspace.js";
import { InMemoryFileSystem } from "../../../src/workspace/in-memory/in-memory-file-system.js";

describe("Windows-shaped paths", () => {
  it("resolves Windows-shaped startDir through the workspace", async () => {
    const ws = await createWorkspace({
      startDir: "C:\\repo\\src",
      fs: new InMemoryFileSystem({
        "C:/repo/.git/HEAD": "ref: refs/heads/main\n",
        "C:/repo/src/x.ts": "",
      }),
    });
    expect(ws.root).toBe("C:/repo");
    expect(ws.toAbsolute("src/x.ts")).toBe("C:/repo/src/x.ts");
    expect(ws.isInWorkspace("C:\\repo\\src\\x.ts")).toBe(true);
    expect(ws.isInWorkspace("C:\\other\\x.ts")).toBe(false);
  });

  it("rejects UNC paths with a clear error", async () => {
    await expect(
      createWorkspace({
        startDir: "\\\\server\\share",
        fs: new InMemoryFileSystem({ "//server/share/.git/HEAD": "" }),
      }),
    ).rejects.toThrow(/UNC/i);
  });
});

describe("Workspace path helpers", () => {
  it("resolveInputPath and toAbsolute round-trip via POSIX paths", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/pkg/sub/file.ts": "",
      }),
    });
    const abs = "/repo/pkg/sub/file.ts";
    const rel = await ws.resolveInputPath(abs, "/repo");
    expect(rel).toBe("pkg/sub/file.ts");
    expect(ws.toAbsolute(rel)).toBe(abs);
  });

  it("isInWorkspace rejects paths above root and sibling-of-root paths", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/x.ts": "",
        "/repo-other/x.ts": "",
        "/other.ts": "",
      }),
    });
    expect(ws.isInWorkspace("/repo/x.ts")).toBe(true);
    expect(ws.isInWorkspace("/repo-other/x.ts")).toBe(false);
    expect(ws.isInWorkspace("/repo/../other.ts")).toBe(false);
  });
});
