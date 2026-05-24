import { describe, expect, it } from "vitest";

import {
  FileNotFoundError,
  InMemoryFileSystem,
  type FileSystem,
  type ResolvedPath,
} from "@symnav/core";

import { extractFileSymbols } from "../../src/extract/extract-file-symbols.js";
import { TypeScriptBackend } from "../../src/typescript-backend/typescript-backend.js";
import { parseTypeScriptSource } from "../helpers/parse-typescript-source.js";

function backendOver(files: Record<string, string>): {
  backend: TypeScriptBackend;
  path: (relative: string) => ResolvedPath;
} {
  const fs = new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n", ...files });
  return {
    backend: new TypeScriptBackend(fs),
    path: (relative) => ({ relative, absolute: `/repo/${relative}` }),
  };
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
  async listDir(absPath: string): Promise<readonly string[]> {
    return this.inner.listDir(absPath);
  }
  async isDirectory(absPath: string): Promise<boolean> {
    return this.inner.isDirectory(absPath);
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

describe("TypeScriptBackend.accepts", () => {
  it("returns true for .ts, .tsx, .mts, .cts, .d.ts; false for .js, .json, .md", () => {
    const { backend } = backendOver({});
    expect(backend.accepts("src/a.ts")).toBe(true);
    expect(backend.accepts("src/a.tsx")).toBe(true);
    expect(backend.accepts("src/a.mts")).toBe(true);
    expect(backend.accepts("src/a.cts")).toBe(true);
    expect(backend.accepts("src/a.d.ts")).toBe(true);
    expect(backend.accepts("src/a.js")).toBe(false);
    expect(backend.accepts("src/a.json")).toBe(false);
    expect(backend.accepts("README.md")).toBe(false);
  });

  it("matches extensions case-sensitively (uppercase variants are rejected)", () => {
    const { backend } = backendOver({});
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
    const { backend, path } = backendOver({ "/repo/src/x.ts": source });
    const result = await backend.fileSymbols(path("src/x.ts"));
    const expected = extractFileSymbols({
      sourceFile: parseTypeScriptSource(source),
      filePath: "src/x.ts",
    });
    expect(result).toEqual(expected);
  });

  it("returns file as the workspace-relative POSIX path", async () => {
    const { backend, path } = backendOver({ "/repo/src/nested/y.ts": source });
    const result = await backend.fileSymbols(path("src/nested/y.ts"));
    expect(result.file).toBe("src/nested/y.ts");
  });

  it("reads the file exclusively through the injected FileSystem", async () => {
    const inner = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/x.ts": source,
    });
    const counting = new CountingFileSystem(inner);
    const backend = new TypeScriptBackend(counting);
    await backend.fileSymbols({ relative: "src/x.ts", absolute: "/repo/src/x.ts" });
    expect(counting.readFileCalls).toContain("/repo/src/x.ts");
  });

  it("on a nonexistent file throws FileNotFoundError", async () => {
    const { backend, path } = backendOver({});
    await expect(backend.fileSymbols(path("src/missing.ts"))).rejects.toBeInstanceOf(
      FileNotFoundError,
    );
  });

  it("parses a .tsx file without ts-morph touching unsupported FileSystemHost methods", async () => {
    const tsxSource = [
      "export function Greeting(props: { name: string }) {",
      "  return <span>{props.name}</span>;",
      "}",
    ].join("\n");
    const { backend, path } = backendOver({ "/repo/src/greeting.tsx": tsxSource });
    const result = await backend.fileSymbols(path("src/greeting.tsx"));
    expect(
      result.symbols.map((s) => [
        s.kind.nativeLabel,
        s.identity.segments[s.identity.segments.length - 1]?.name,
      ]),
    ).toEqual([["function", "Greeting"]]);
  });
});
