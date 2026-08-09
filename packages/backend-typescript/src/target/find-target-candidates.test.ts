import { describe, expect, it } from "vitest";
import {
  InMemoryFileSystem,
  SymbolTargetGrammar,
  type ResolvedPath,
  type SymbolTargetCandidate,
} from "@symnav/core";

import { WorkspaceDeclarationIndex } from "../identity/workspace-declaration-index.js";
import { TargetCandidateFinder } from "./find-target-candidates.js";

const FIXTURE: Record<string, string> = {
  "/repo/.git/HEAD": "ref: refs/heads/main\n",
  "/repo/src/helpers.ts": ["export function helper(): string {", '  return "ok";', "}", ""].join(
    "\n",
  ),
  "/repo/src/json.ts": [
    "export function parse(input: string): unknown {",
    "  return JSON.parse(input) as unknown;",
    "}",
    "",
  ].join("\n"),
  "/repo/src/query.ts": [
    "export function parse(input: URLSearchParams): Record<string, string> {",
    "  return Object.fromEntries(input.entries());",
    "}",
    "",
  ].join("\n"),
  "/repo/src/spaced.ts": [
    "export function pad(): void {}",
    "",
    "export function parse(input: number): string {",
    "  return String(input);",
    "}",
    "",
  ].join("\n"),
  "/repo/src/control-flow.ts": [
    "export function outer(flag: boolean): void {",
    "  if (flag) {",
    "    function insideIf(): void {}",
    "    insideIf();",
    "  }",
    "}",
    "",
  ].join("\n"),
  "/repo/src/router.ts": [
    "export class Router {",
    "  post(path: string): void;",
    "  post(path: RegExp): void;",
    "  post(path: string | RegExp): void {}",
    "}",
    "",
  ].join("\n"),
};

const ALL_FILES = pathsFor([
  "src/control-flow.ts",
  "src/helpers.ts",
  "src/json.ts",
  "src/query.ts",
  "src/router.ts",
]);

function regularQuery(raw: string) {
  return { mode: "regular", pattern: SymbolTargetGrammar.parse(raw) } as const;
}

function regexQuery(raw: string) {
  return { mode: "regex", raw, regex: new RegExp(raw) } as const;
}

function pathsFor(relativePaths: readonly string[]): readonly ResolvedPath[] {
  return relativePaths.map((relative) => ({ relative, absolute: `/repo/${relative}` }));
}

function fsWithFixture() {
  return new InMemoryFileSystem(FIXTURE);
}

function sortedCanonicalIds(candidates: readonly SymbolTargetCandidate[]): readonly string[] {
  return candidates.map((candidate) => candidate.canonicalId).sort();
}

describe("TargetCandidateFinder.find", () => {
  it("returns the one candidate matching a unique bare-name pattern", async () => {
    const candidates = await TargetCandidateFinder.find({
      declarationIndex: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      query: regularQuery("helper"),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.symbol.identity).toEqual({
      file: "src/helpers.ts",
      segments: [{ name: "helper" }],
    });
    expect(candidates[0]!.canonicalId).toBe("src/helpers.ts::helper");
    expect(candidates[0]!.header.lines.join("\n")).toContain("export function helper(): string");
  });

  it("walks through fold nodes while returning only declaration symbols", async () => {
    const candidates = await TargetCandidateFinder.find({
      declarationIndex: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      query: regularQuery("insideIf"),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.symbol.type).toBe("symbol");
    expect(candidates[0]!.symbol.identity).toEqual({
      file: "src/control-flow.ts",
      segments: [{ name: "outer" }, { name: "insideIf" }],
    });
  });

  it("returns an empty list for zero matches without throwing", async () => {
    const candidates = await TargetCandidateFinder.find({
      declarationIndex: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      query: regularQuery("missing"),
    });

    expect(candidates).toEqual([]);
  });

  it("returns every matching declaration candidate in any order", async () => {
    const candidates = await TargetCandidateFinder.find({
      declarationIndex: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      query: regularQuery("parse"),
    });

    expect(sortedCanonicalIds(candidates)).toEqual(["src/json.ts::parse", "src/query.ts::parse"]);
  });

  it("matches regex queries against full canonical ids including paths and nested segments", async () => {
    const candidates = await TargetCandidateFinder.find({
      declarationIndex: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      query: regexQuery("^src/control-flow\\.ts::outer::insideIf$"),
    });

    expect(sortedCanonicalIds(candidates)).toEqual(["src/control-flow.ts::outer::insideIf"]);
  });

  it("matches regex queries against overload disambiguators", async () => {
    const candidates = await TargetCandidateFinder.find({
      declarationIndex: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      query: regexQuery("Router::post#2$"),
    });

    expect(sortedCanonicalIds(candidates)).toEqual(["src/router.ts::Router::post#2"]);
  });

  it("matches regex queries case-sensitively", async () => {
    const candidates = await TargetCandidateFinder.find({
      declarationIndex: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      query: regexQuery("HELPER$"),
    });

    expect(candidates).toEqual([]);
  });

  it("does not regex-match headers, signatures, previews, or source text", async () => {
    const candidates = await TargetCandidateFinder.find({
      declarationIndex: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      query: regexQuery('export function|return \\"ok\\"|string'),
    });

    expect(candidates).toEqual([]);
  });
});
