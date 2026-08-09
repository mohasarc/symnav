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
};

const ALL_FILES = pathsFor([
  "src/control-flow.ts",
  "src/helpers.ts",
  "src/json.ts",
  "src/query.ts",
]);

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
      pattern: SymbolTargetGrammar.parse("helper"),
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
      pattern: SymbolTargetGrammar.parse("insideIf"),
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
      pattern: SymbolTargetGrammar.parse("missing"),
    });

    expect(candidates).toEqual([]);
  });

  it("returns every matching declaration candidate in any order", async () => {
    const candidates = await TargetCandidateFinder.find({
      declarationIndex: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      pattern: SymbolTargetGrammar.parse("parse"),
    });

    expect(sortedCanonicalIds(candidates)).toEqual(["src/json.ts::parse", "src/query.ts::parse"]);
  });
});
