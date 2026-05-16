import { describe, expect, it } from "vitest";
import { createWorkspace } from "../../../src/workspace/workspace.js";
import { InMemoryFileSystem } from "../../../src/workspace/in-memory/in-memory-file-system.js";
import { OutsideWorkspaceError } from "../../../src/workspace/errors.js";

describe("Windows-shaped paths", () => {
  it("normalises Windows-shaped startDir into a POSIX workspace root", async () => {
    const ws = await createWorkspace({
      startDir: "C:\\repo\\src",
      fs: new InMemoryFileSystem({
        "C:/repo/.git/HEAD": "ref: refs/heads/main\n",
        "C:/repo/src/x.ts": "",
      }),
    });
    expect(ws.root).toBe("C:/repo");
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
  it("resolveInputPath returns both relative and absolute POSIX paths", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/pkg/sub/file.ts": "",
      }),
    });
    expect(await ws.resolveInputPath("/repo/pkg/sub/file.ts", "/repo")).toEqual({
      relative: "pkg/sub/file.ts",
      absolute: "/repo/pkg/sub/file.ts",
    });
  });

  it("rejects paths above root and sibling-of-root paths", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/x.ts": "",
        "/repo-other/x.ts": "",
        "/other.ts": "",
      }),
    });
    expect(await ws.resolveInputPath("/repo/x.ts", "/repo")).toEqual({
      relative: "x.ts",
      absolute: "/repo/x.ts",
    });
    await expect(ws.resolveInputPath("/repo-other/x.ts", "/repo")).rejects.toBeInstanceOf(
      OutsideWorkspaceError,
    );
    await expect(ws.resolveInputPath("/other.ts", "/repo")).rejects.toBeInstanceOf(
      OutsideWorkspaceError,
    );
  });
});
