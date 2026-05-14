import { describe, expect, it } from "vitest";
import { InMemoryFileSystem } from "../in-memory/in-memory-file-system.js";
import { WorkspaceIgnore } from "./workspace-ignore.js";

describe("WorkspaceIgnore", () => {
  it("honors a single root .gitignore", () => {
    const fs = new InMemoryFileSystem({
      "/repo/.gitignore": "dist/\n",
      "/repo/dist/x.js": "",
      "/repo/src/x.ts": "",
    });
    const ignore = WorkspaceIgnore.build("/repo", fs);
    expect(ignore.isIgnored("dist/x.js")).toBe(true);
    expect(ignore.isIgnored("src/x.ts")).toBe(false);
  });

  it("aggregates subdirectory .gitignore files", () => {
    const fs = new InMemoryFileSystem({
      "/repo/.gitignore": "",
      "/repo/pkg/.gitignore": "temp.ts\n",
      "/repo/pkg/temp.ts": "",
      "/repo/temp.ts": "",
    });
    const ignore = WorkspaceIgnore.build("/repo", fs);
    expect(ignore.isIgnored("pkg/temp.ts")).toBe(true);
    expect(ignore.isIgnored("temp.ts")).toBe(false);
  });

  it("returns false for a path matched by no scope", () => {
    const fs = new InMemoryFileSystem({
      "/repo/.gitignore": "dist/\n",
      "/repo/src/x.ts": "",
    });
    const ignore = WorkspaceIgnore.build("/repo", fs);
    expect(ignore.isIgnored("src/x.ts")).toBe(false);
  });

  it("always ignores .git/ and any path under it", () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/x.ts": "",
    });
    const ignore = WorkspaceIgnore.build("/repo", fs);
    expect(ignore.isIgnored(".git")).toBe(true);
    expect(ignore.isIgnored(".git/HEAD")).toBe(true);
    expect(ignore.isIgnored(".git/refs/heads/main")).toBe(true);
  });

  it("does not descend into .git/ or already-ignored directories during build", () => {
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
    WorkspaceIgnore.build("/repo", fs);
    expect(listed).not.toContain("/repo/.git");
    expect(listed).not.toContain("/repo/node_modules");
    expect(listed).toContain("/repo/src");
  });

  it("does not ignore the empty or root path", () => {
    const fs = new InMemoryFileSystem({
      "/repo/.gitignore": "dist/\n",
      "/repo/dist/x.js": "",
    });
    const ignore = WorkspaceIgnore.build("/repo", fs);
    expect(ignore.isIgnored("")).toBe(false);
    expect(ignore.isIgnored("/")).toBe(false);
  });
});
