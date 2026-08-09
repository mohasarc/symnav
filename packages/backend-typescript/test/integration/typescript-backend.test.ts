import { describe, expect, it } from "vitest";

import {
  FileNotFoundError,
  formatSymbolIdentity,
  InMemoryFileSystem,
  SymbolTargetGrammar,
  type FileSystem,
  type ResolvedPath,
  OverviewTree,
} from "@symnav/core";

import { extractFileEntries } from "../../src/extract/extract-file-entries.js";
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

describe("TypeScriptBackend.fileEntries", () => {
  const source = ["export class Greeter {", "  hello(): string { return 'hi'; }", "}"].join("\n");

  it("produces IR matching extractFileEntries over the same source", async () => {
    const { backend, path } = backendOver({ "/repo/src/x.ts": source });
    const result = await backend.fileEntries(path("src/x.ts"));
    const expected = extractFileEntries({
      sourceFile: parseTypeScriptSource(source),
      filePath: "src/x.ts",
    });
    expect(result).toEqual(expected);
  });

  it("returns file as the workspace-relative POSIX path", async () => {
    const { backend, path } = backendOver({ "/repo/src/nested/y.ts": source });
    const result = await backend.fileEntries(path("src/nested/y.ts"));
    expect(result.file).toBe("src/nested/y.ts");
  });

  it("reads the file exclusively through the injected FileSystem", async () => {
    const inner = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/x.ts": source,
    });
    const counting = new CountingFileSystem(inner);
    const backend = new TypeScriptBackend(counting);
    await backend.fileEntries({ relative: "src/x.ts", absolute: "/repo/src/x.ts" });
    expect(counting.readFileCalls).toContain("/repo/src/x.ts");
  });

  it("on a nonexistent file throws FileNotFoundError", async () => {
    const { backend, path } = backendOver({});
    await expect(backend.fileEntries(path("src/missing.ts"))).rejects.toBeInstanceOf(
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
    const result = await backend.fileEntries(path("src/greeting.tsx"));
    expect(
      OverviewTree.walkSymbols(result.entries).map((s) => [
        s.kind.nativeLabel,
        s.identity.segments[s.identity.segments.length - 1]?.name,
      ]),
    ).toEqual([["function-implementation", "Greeting"]]);
  });

  it("returns declarations nested inside executable control-flow blocks", async () => {
    const sourceWithLocalDeclarations = [
      "export function outer(flag: boolean): void {",
      "  if (flag) {",
      "    function insideIf(): void {}",
      "    insideIf();",
      "  }",
      "}",
    ].join("\n");
    const { backend, path } = backendOver({
      "/repo/src/control-flow.ts": sourceWithLocalDeclarations,
    });
    const result = await backend.fileEntries(path("src/control-flow.ts"));
    const outer = result.entries[0];
    if (!outer || outer.type !== "symbol") throw new Error("expected outer symbol");
    const folds = OverviewTree.directFolds(outer.children);
    expect(folds.map((fold) => [fold.foldKind, fold.header.lines])).toEqual([
      ["conditional", ["if (flag) {"]],
    ]);
    expect(
      OverviewTree.walkSymbols(outer.children).map((symbol) =>
        formatSymbolIdentity(symbol.identity),
      ),
    ).toEqual(["src/control-flow.ts::outer::insideIf"]);
  });
});

describe("TypeScriptBackend parse sharing", () => {
  it("reads each workspace file at most once across findTargetCandidates and findDefinitions", async () => {
    const inner = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/lib.ts": "export function helper(): void {}\n",
      "/repo/src/app.ts": [
        'import { helper } from "./lib.js";',
        "",
        "export function main(): void {",
        "  helper();",
        "}",
        "",
      ].join("\n"),
    });
    const counting = new CountingFileSystem(inner);
    const backend = new TypeScriptBackend(counting);
    const files: readonly ResolvedPath[] = [
      { relative: "src/app.ts", absolute: "/repo/src/app.ts" },
      { relative: "src/lib.ts", absolute: "/repo/src/lib.ts" },
    ];

    const candidates = await backend.findTargetCandidates(files, {
      mode: "regular",
      pattern: SymbolTargetGrammar.parse("helper"),
    });
    const definitions = await backend.findDefinitions(files, {
      file: "src/lib.ts",
      segments: [{ name: "helper" }],
    });

    expect(candidates).toHaveLength(1);
    expect(definitions).toHaveLength(1);
    const sourceReads = counting.readFileCalls.filter((path) => path.startsWith("/repo/src/"));
    expect(new Set(sourceReads)).toEqual(new Set(["/repo/src/app.ts", "/repo/src/lib.ts"]));
    expect(sourceReads).toHaveLength(2);
  });
});

describe("TypeScriptBackend.findReferences", () => {
  it("finds references nested inside executable control-flow blocks", async () => {
    const files: Record<string, string> = {
      "/repo/src/lib/run.ts": "export function run(): void {}\n",
      "/repo/src/app/run-user.ts": [
        'import { run } from "../lib/run.js";',
        "",
        "export function main(items: readonly string[], enabled: boolean): void {",
        "  if (enabled) {",
        "    run();",
        "  }",
        "  for (const item of items) {",
        "    if (item) {",
        "      run();",
        "    }",
        "  }",
        "  while (enabled) {",
        "    run();",
        "    break;",
        "  }",
        "}",
        "",
      ].join("\n"),
    };
    const { backend, path } = backendOver(files);
    const result = await backend.findReferences(
      [path("src/app/run-user.ts"), path("src/lib/run.ts")],
      { file: "src/lib/run.ts", segments: [{ name: "run" }] },
    );
    expect(result.map((reference) => [reference.file, reference.line, reference.kind])).toEqual([
      ["src/app/run-user.ts", 1, "import"],
      ["src/app/run-user.ts", 5, "usage"],
      ["src/app/run-user.ts", 9, "usage"],
      ["src/app/run-user.ts", 13, "usage"],
    ]);
  });
});
