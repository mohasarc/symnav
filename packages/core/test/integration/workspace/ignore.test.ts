import { describe, expect, it } from "vitest";
import { createWorkspace } from "../../../src/workspace/workspace.js";
import { InMemoryFileSystem } from "../../../src/workspace/in-memory/in-memory-file-system.js";
import { IgnoredFileError } from "../../../src/workspace/errors.js";

describe("Workspace ignore handling", () => {
  it("honors a single root .gitignore", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "dist/\n",
        "/repo/dist/x.js": "",
        "/repo/src/x.ts": "",
      }),
    });
    await expect(ws.resolveInputPath("dist/x.js", "/repo")).rejects.toBeInstanceOf(
      IgnoredFileError,
    );
    expect((await ws.resolveInputPath("src/x.ts", "/repo")).relative).toBe("src/x.ts");
  });

  it("aggregates subdirectory .gitignore files", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "",
        "/repo/pkg/.gitignore": "temp.ts\n",
        "/repo/pkg/temp.ts": "",
        "/repo/temp.ts": "",
      }),
    });
    await expect(ws.resolveInputPath("pkg/temp.ts", "/repo")).rejects.toBeInstanceOf(
      IgnoredFileError,
    );
    expect((await ws.resolveInputPath("temp.ts", "/repo")).relative).toBe("temp.ts");
  });

  it("anchors sub-.gitignore patterns with internal slashes to that subdirectory", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/pkg/.gitignore": "build/output\n",
        "/repo/pkg/build/output/x.js": "",
        "/repo/pkg/sub/build/output/x.js": "",
      }),
    });
    await expect(ws.resolveInputPath("pkg/build/output/x.js", "/repo")).rejects.toBeInstanceOf(
      IgnoredFileError,
    );
    expect((await ws.resolveInputPath("pkg/sub/build/output/x.js", "/repo")).relative).toBe(
      "pkg/sub/build/output/x.js",
    );
  });

  it("honors negation", async () => {
    // gitignore(5): wholesale `dist/` cannot be re-included — list contents (`dist/*`) to allow `!`.
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "dist/*\n!dist/keep.js\n",
        "/repo/dist/keep.js": "",
        "/repo/dist/other.js": "",
      }),
    });
    expect((await ws.resolveInputPath("dist/keep.js", "/repo")).relative).toBe("dist/keep.js");
    await expect(ws.resolveInputPath("dist/other.js", "/repo")).rejects.toBeInstanceOf(
      IgnoredFileError,
    );
  });

  it("always rejects paths under .git/", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "",
      }),
    });
    await expect(ws.resolveInputPath(".git/HEAD", "/repo")).rejects.toBeInstanceOf(
      IgnoredFileError,
    );
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

  it("ignores nothing (except .git/) when no .gitignore exists", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "",
        "/repo/dist/x.js": "",
      }),
    });
    expect((await ws.resolveInputPath("src/x.ts", "/repo")).relative).toBe("src/x.ts");
    expect((await ws.resolveInputPath("dist/x.js", "/repo")).relative).toBe("dist/x.js");
    await expect(ws.resolveInputPath(".git/HEAD", "/repo")).rejects.toBeInstanceOf(
      IgnoredFileError,
    );
  });
});
