import { describe, expect, it } from "vitest";

import {
  FileNotFoundError,
  InMemoryFileSystem,
  InMemoryWorkspace,
  OutsideWorkspaceError,
  type FileSystem,
  type Workspace,
} from "@symnav/core";

import { extractFileSymbols } from "../../src/extract/extract-file-symbols.js";
import { TypeScriptBackend } from "../../src/typescript-backend/typescript-backend.js";
import { parseTypeScriptSource } from "../helpers/parse-typescript-source.js";

async function workspaceOver(files: Record<string, string>): Promise<InMemoryWorkspace> {
  return InMemoryWorkspace.create({
    files: { "/repo/.git/HEAD": "ref: refs/heads/main\n", ...files },
    startDir: "/repo",
  });
}

async function backendOver(files: Record<string, string>): Promise<TypeScriptBackend> {
  const workspace = await workspaceOver(files);
  return new TypeScriptBackend(workspace);
}

class CountingFileSystem implements FileSystem {
  readFileCalls: string[] = [];
  constructor(private readonly inner: FileSystem) {}
  async readFile(absPath: string): Promise<string> {
    this.readFileCalls.push(absPath);
    return this.inner.readFile(absPath);
  }
  async exists(absPath: string): Promise<boolean> {
    return this.inner.exists(absPath);
  }
  existsSync(absPath: string): boolean {
    return this.inner.existsSync(absPath);
  }
  readFileSync(absPath: string): string {
    this.readFileCalls.push(absPath);
    return this.inner.readFileSync(absPath);
  }
  listDirSync(absPath: string): readonly string[] {
    return this.inner.listDirSync(absPath);
  }
  isDirectorySync(absPath: string): boolean {
    return this.inner.isDirectorySync(absPath);
  }
}

class WrappedWorkspace implements Workspace {
  constructor(
    private readonly inner: Workspace,
    public readonly fs: FileSystem,
  ) {}
  get root(): string {
    return this.inner.root;
  }
  toRelative(absPath: string): string {
    return this.inner.toRelative(absPath);
  }
  toAbsolute(relPath: string): string {
    return this.inner.toAbsolute(relPath);
  }
  isInWorkspace(absPath: string): boolean {
    return this.inner.isInWorkspace(absPath);
  }
  isIgnored(relPath: string): boolean {
    return this.inner.isIgnored(relPath);
  }
}

describe("TypeScriptBackend.accepts", () => {
  it("returns true for .ts, .tsx, .mts, .cts, .d.ts; false for .js, .json, .md", async () => {
    const backend = await backendOver({});
    expect(backend.accepts("src/a.ts")).toBe(true);
    expect(backend.accepts("src/a.tsx")).toBe(true);
    expect(backend.accepts("src/a.mts")).toBe(true);
    expect(backend.accepts("src/a.cts")).toBe(true);
    expect(backend.accepts("src/a.d.ts")).toBe(true);
    expect(backend.accepts("src/a.js")).toBe(false);
    expect(backend.accepts("src/a.json")).toBe(false);
    expect(backend.accepts("README.md")).toBe(false);
  });

  it("matches extensions case-sensitively (uppercase variants are rejected)", async () => {
    const backend = await backendOver({});
    expect(backend.accepts("src/a.TS")).toBe(false);
    expect(backend.accepts("src/a.TSX")).toBe(false);
    expect(backend.accepts("src/a.D.TS")).toBe(false);
  });

  it("exposes extension knowledge statically (no workspace required)", () => {
    expect(TypeScriptBackend.accepts("src/a.ts")).toBe(true);
    expect(TypeScriptBackend.accepts("src/a.js")).toBe(false);
    expect(TypeScriptBackend.extensions).toEqual([".d.ts", ".ts", ".tsx", ".mts", ".cts"]);
  });
});

describe("TypeScriptBackend.fileSymbols", () => {
  const source = ["export class Greeter {", "  hello(): string { return 'hi'; }", "}"].join("\n");

  it("produces IR matching extractFileSymbols over the same source", async () => {
    const backend = await backendOver({ "/repo/src/x.ts": source });
    const result = await backend.fileSymbols("src/x.ts");
    const expected = extractFileSymbols({
      sourceFile: parseTypeScriptSource(source),
      filePath: "src/x.ts",
    });
    expect(result).toEqual(expected);
  });

  it("returns filePath as the workspace-relative POSIX path", async () => {
    const backend = await backendOver({ "/repo/src/nested/y.ts": source });
    const result = await backend.fileSymbols("src/nested/y.ts");
    expect(result.filePath).toBe("src/nested/y.ts");
  });

  it("reads the file exclusively through Workspace.fs", async () => {
    const inner = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/x.ts": source,
    });
    const counting = new CountingFileSystem(inner);
    const baseWorkspace = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": source,
      },
      startDir: "/repo",
    });
    const workspace = new WrappedWorkspace(baseWorkspace, counting);
    const backend = new TypeScriptBackend(workspace);
    await backend.fileSymbols("src/x.ts");
    expect(counting.readFileCalls).toContain("/repo/src/x.ts");
  });

  it("on a nonexistent file throws FileNotFoundError", async () => {
    const backend = await backendOver({});
    await expect(backend.fileSymbols("src/missing.ts")).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("on a path that resolves outside the workspace throws OutsideWorkspaceError", async () => {
    const backend = await backendOver({});
    await expect(backend.fileSymbols("../outside.ts")).rejects.toBeInstanceOf(
      OutsideWorkspaceError,
    );
  });

  it("parses a .tsx file without ts-morph touching unsupported FileSystemHost methods", async () => {
    const tsxSource = [
      "export function Greeting(props: { name: string }) {",
      "  return <span>{props.name}</span>;",
      "}",
    ].join("\n");
    const backend = await backendOver({ "/repo/src/greeting.tsx": tsxSource });
    const result = await backend.fileSymbols("src/greeting.tsx");
    expect(result.symbols.map((s) => [s.kind.nativeLabel, s.name])).toEqual([
      ["function", "Greeting"],
    ]);
  });
});
