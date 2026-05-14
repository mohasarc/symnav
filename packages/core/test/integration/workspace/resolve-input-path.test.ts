import { describe, expect, it } from "vitest";
import { createWorkspace } from "../../../src/workspace/workspace.js";
import { InMemoryFileSystem } from "../../../src/workspace/in-memory/in-memory-file-system.js";
import {
  FileNotFoundError,
  IgnoredFileError,
  OutsideWorkspaceError,
} from "../../../src/workspace/errors.js";

describe("Workspace.resolveInputPath", () => {
  it("resolves a relative input against fromDir into a workspace-relative POSIX path", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/nested/a.ts": "export const x = 1;",
      }),
    });
    expect(await ws.resolveInputPath("a.ts", "/repo/src/nested")).toBe("src/nested/a.ts");
  });

  it("returns an absolute input inside the workspace as a workspace-relative path", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/a.ts": "export const x = 1;",
      }),
    });
    expect(await ws.resolveInputPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
  });

  it("throws FileNotFoundError when the resolved path does not exist", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" }),
    });
    await expect(ws.resolveInputPath("src/missing.ts", "/repo")).rejects.toBeInstanceOf(
      FileNotFoundError,
    );
  });

  it("throws OutsideWorkspaceError for a path outside the workspace root", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/other/src/a.ts": "export const x = 1;",
      }),
    });
    await expect(ws.resolveInputPath("/other/src/a.ts", "/repo")).rejects.toBeInstanceOf(
      OutsideWorkspaceError,
    );
  });

  it("throws IgnoredFileError when the path matches an ignore rule", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "build/\n",
        "/repo/build/a.ts": "export const x = 1;",
      }),
    });
    await expect(ws.resolveInputPath("build/a.ts", "/repo")).rejects.toBeInstanceOf(
      IgnoredFileError,
    );
  });
});
