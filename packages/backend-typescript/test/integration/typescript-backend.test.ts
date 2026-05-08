import { describe, expect, it } from "vitest";
import { FileNotFoundError, type WorkspaceFileSystem } from "@symnav/core";
import { inMemoryFileSystem, inMemoryWorkspace, parseTs } from "@symnav/testing";
import { createWorkspace } from "@symnav/core";
import { extractFileSymbols } from "../../src/extract.js";
import { TypeScriptBackend } from "../../src/typescript-backend.js";

describe("TypeScriptBackend.accepts", () => {
  it("returns true for TypeScript file extensions and false for others", async () => {
    const workspace = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "export const x = 1;\n",
      },
      startDir: "/repo",
    });
    const backend = new TypeScriptBackend(workspace);

    expect(backend.accepts("src/a.ts")).toBe(true);
    expect(backend.accepts("src/a.tsx")).toBe(true);
    expect(backend.accepts("src/a.mts")).toBe(true);
    expect(backend.accepts("src/a.cts")).toBe(true);
    expect(backend.accepts("src/a.d.ts")).toBe(true);
    expect(backend.accepts("src/A.TS")).toBe(true);

    expect(backend.accepts("src/a.js")).toBe(false);
    expect(backend.accepts("package.json")).toBe(false);
    expect(backend.accepts("README.md")).toBe(false);
    expect(backend.accepts("src/a")).toBe(false);
  });
});

describe("TypeScriptBackend.fileSymbols", () => {
  const SOURCE = [
    "export class CheckoutService {",
    "  constructor(public readonly id: string) {}",
    "  process(amount: number): boolean {",
    "    return amount > 0;",
    "  }",
    "}",
    "",
  ].join("\n");

  it("produces IR matching extractFileSymbols over the same source", async () => {
    const workspace = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/checkout.ts": SOURCE,
      },
      startDir: "/repo",
    });
    const backend = new TypeScriptBackend(workspace);

    const actual = await backend.fileSymbols("src/checkout.ts");

    const expected = extractFileSymbols({
      sourceFile: parseTs(SOURCE, "src/checkout.ts"),
      filePath: "src/checkout.ts",
    });
    expect(actual).toEqual(expected);
  });

  it("returns the supplied workspace-relative POSIX path verbatim on the IR", async () => {
    const workspace = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/checkout.ts": SOURCE,
      },
      startDir: "/repo",
    });
    const backend = new TypeScriptBackend(workspace);

    const result = await backend.fileSymbols("src/checkout.ts");

    expect(result.filePath).toBe("src/checkout.ts");
  });

  it("reads the file through Workspace.fs rather than directly from disk", async () => {
    const inner = inMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/checkout.ts": SOURCE,
    });
    const reads: string[] = [];
    const counting: WorkspaceFileSystem = {
      readFile: (path) => {
        reads.push(path);
        return inner.readFile(path);
      },
      readFileSync: (path) => {
        reads.push(path);
        return inner.readFileSync(path);
      },
      exists: inner.exists.bind(inner),
      existsSync: inner.existsSync.bind(inner),
      listDirSync: inner.listDirSync.bind(inner),
      isDirectorySync: inner.isDirectorySync.bind(inner),
    };
    const workspace = await createWorkspace({ startDir: "/repo", fs: counting });
    const backend = new TypeScriptBackend(workspace);

    await backend.fileSymbols("src/checkout.ts");

    expect(reads).toContain("/repo/src/checkout.ts");
  });

  it("throws FileNotFoundError when the path does not exist", async () => {
    const workspace = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "export const x = 1;\n",
      },
      startDir: "/repo",
    });
    const backend = new TypeScriptBackend(workspace);

    await expect(backend.fileSymbols("src/missing.ts")).rejects.toBeInstanceOf(FileNotFoundError);
  });
});
