import { describe, expect, it } from "vitest";
import { createWorkspace, InMemoryFileSystem } from "@symnav/core";

describe("Workspace.isIgnored", () => {
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
    expect(ws.isIgnored("dist/x.js")).toBe(true);
    expect(ws.isIgnored("src/x.ts")).toBe(false);
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
    expect(ws.isIgnored("pkg/temp.ts")).toBe(true);
    expect(ws.isIgnored("temp.ts")).toBe(false);
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
    expect(ws.isIgnored("pkg/build/output/x.js")).toBe(true);
    expect(ws.isIgnored("pkg/sub/build/output/x.js")).toBe(false);
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
    expect(ws.isIgnored("dist/keep.js")).toBe(false);
    expect(ws.isIgnored("dist/other.js")).toBe(true);
  });

  it("always rejects .git/ and any path under it", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "",
      }),
    });
    expect(ws.isIgnored(".git")).toBe(true);
    expect(ws.isIgnored(".git/HEAD")).toBe(true);
    expect(ws.isIgnored(".git/refs/heads/main")).toBe(true);
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

  it("returns false for everything (except .git/) when no .gitignore exists", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "",
        "/repo/dist/x.js": "",
      }),
    });
    expect(ws.isIgnored("src/x.ts")).toBe(false);
    expect(ws.isIgnored("dist/x.js")).toBe(false);
    expect(ws.isIgnored(".git/HEAD")).toBe(true);
  });
});
