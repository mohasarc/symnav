import { describe, expect, it } from "vitest";
import { FileNotFoundError, type WorkspaceFileSystem } from "@symnav/core";
import { inMemoryWorkspace } from "@symnav/testing";
import { TypeScriptBackend } from "../../src/typescript-backend.js";

describe("TypeScriptBackend.accepts", () => {
  it("returns true for .ts/.tsx/.mts/.cts/.d.ts and false for non-TS files", async () => {
    const workspace = await inMemoryWorkspace({
      files: { "/repo/.git/HEAD": "", "/repo/src/x.ts": "" },
      startDir: "/repo",
    });
    const backend = new TypeScriptBackend(workspace);
    expect(backend.accepts("src/x.ts")).toBe(true);
    expect(backend.accepts("src/x.tsx")).toBe(true);
    expect(backend.accepts("src/x.mts")).toBe(true);
    expect(backend.accepts("src/x.cts")).toBe(true);
    expect(backend.accepts("src/x.d.ts")).toBe(true);
    expect(backend.accepts("src/x.js")).toBe(false);
    expect(backend.accepts("src/x.json")).toBe(false);
    expect(backend.accepts("README.md")).toBe(false);
  });
});

describe("TypeScriptBackend.fileSymbols", () => {
  it("produces IR for an in-memory file with the workspace-relative path", async () => {
    const workspace = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "",
        "/repo/src/x.ts": "export class Foo { greet(): void {} }",
      },
      startDir: "/repo",
    });
    const backend = new TypeScriptBackend(workspace);
    const file = await backend.fileSymbols("src/x.ts");
    expect(file.filePath).toBe("src/x.ts");
    expect(file.symbols).toHaveLength(1);
    const klass = file.symbols[0]!;
    expect(klass.kind).toBe("class");
    expect(klass.name).toBe("Foo");
    expect(klass.children[0]?.name).toBe("greet");
  });

  it("reads the file through Workspace.fs (not directly from disk)", async () => {
    const workspace = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "",
        "/repo/src/y.ts": "export const y: number = 1;",
      },
      startDir: "/repo",
    });
    const calls: string[] = [];
    const counted: WorkspaceFileSystem = {
      ...workspace.fs,
      readFileSync(absPath) {
        calls.push(absPath);
        return workspace.fs.readFileSync(absPath);
      },
      async readFile(absPath) {
        calls.push(absPath);
        return workspace.fs.readFile(absPath);
      },
    };
    const wrapped = { ...workspace, fs: counted };
    const backend = new TypeScriptBackend(wrapped);
    await backend.fileSymbols("src/y.ts");
    expect(calls.some((p) => p.endsWith("src/y.ts"))).toBe(true);
  });

  it("throws FileNotFoundError when the file does not exist", async () => {
    const workspace = await inMemoryWorkspace({
      files: { "/repo/.git/HEAD": "" },
      startDir: "/repo",
    });
    const backend = new TypeScriptBackend(workspace);
    await expect(backend.fileSymbols("missing.ts")).rejects.toBeInstanceOf(FileNotFoundError);
  });
});
