import { describe, expect, it } from "vitest";
import { createWorkspace } from "../../../src/workspace/workspace.js";
import { InMemoryFileSystem } from "../../../src/workspace/in-memory/in-memory-file-system.js";

describe("Workspace.enumerate", () => {
  it("returns every non-ignored file under the workspace root as ResolvedPath", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/a.ts": "export const a = 1;",
        "/repo/src/nested/b.ts": "export const b = 2;",
        "/repo/README.md": "# repo\n",
      }),
    });
    const files = await ws.enumerate();
    expect(files).toEqual([
      { relative: "README.md", absolute: "/repo/README.md" },
      { relative: "src/a.ts", absolute: "/repo/src/a.ts" },
      { relative: "src/nested/b.ts", absolute: "/repo/src/nested/b.ts" },
    ]);
  });

  it("skips files matched by .gitignore", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "build/\nsecret.ts\n",
        "/repo/src/a.ts": "export const a = 1;",
        "/repo/build/out.ts": "export const out = 0;",
        "/repo/secret.ts": "export const s = 0;",
      }),
    });
    const files = await ws.enumerate();
    const relatives = files.map((f) => f.relative);
    expect(relatives).not.toContain("build/out.ts");
    expect(relatives).not.toContain("secret.ts");
    expect(relatives).toContain("src/a.ts");
  });

  it("skips files under .git/", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.git/config": "[core]\n",
        "/repo/src/a.ts": "export const a = 1;",
      }),
    });
    const files = await ws.enumerate();
    const relatives = files.map((f) => f.relative);
    expect(relatives).not.toContain(".git/HEAD");
    expect(relatives).not.toContain(".git/config");
    expect(relatives).toEqual(["src/a.ts"]);
  });

  it("returns paths sorted by workspace-relative POSIX path", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/zeta.ts": "",
        "/repo/alpha.ts": "",
        "/repo/src/beta.ts": "",
        "/repo/src/aardvark.ts": "",
      }),
    });
    const files = await ws.enumerate();
    expect(files.map((f) => f.relative)).toEqual([
      "alpha.ts",
      "src/aardvark.ts",
      "src/beta.ts",
      "zeta.ts",
    ]);
  });

  it("returns the same order on repeated calls", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/c.ts": "",
        "/repo/a.ts": "",
        "/repo/b.ts": "",
      }),
    });
    const first = await ws.enumerate();
    const second = await ws.enumerate();
    expect(second).toEqual(first);
  });
});
