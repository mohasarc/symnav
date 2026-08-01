import { describe, expect, it } from "vitest";
import {
  AmbiguousSymbolTargetError,
  InMemoryFileSystem,
  SymbolTargetNotFoundError,
  parseSymbolTargetPattern,
  type ResolvedPath,
} from "@symnav/core";

import { resolveSymbolTarget } from "./resolve-symbol-target.js";

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

describe("resolveSymbolTarget", () => {
  it("resolves a unique bare-name pattern", async () => {
    const result = await resolveSymbolTarget({
      fs: fsWithFixture(),
      files: ALL_FILES,
      pattern: parseSymbolTargetPattern("helper"),
      options: { containingLine: undefined },
    });

    expect(result.identity).toEqual({ file: "src/helpers.ts", segments: [{ name: "helper" }] });
  });

  it("walks through fold nodes while returning only declaration symbols", async () => {
    const result = await resolveSymbolTarget({
      fs: fsWithFixture(),
      files: ALL_FILES,
      pattern: parseSymbolTargetPattern("insideIf"),
      options: { containingLine: undefined },
    });

    expect(result.type).toBe("symbol");
    expect(result.identity).toEqual({
      file: "src/control-flow.ts",
      segments: [{ name: "outer" }, { name: "insideIf" }],
    });
  });

  it("keeps a target when the supplied line is inside its declaration range", async () => {
    const result = await resolveSymbolTarget({
      fs: fsWithFixture(),
      files: ALL_FILES,
      pattern: parseSymbolTargetPattern("helper"),
      options: { containingLine: 2 },
    });

    expect(result.identity.file).toBe("src/helpers.ts");
  });

  it("throws not-found for zero matches", async () => {
    await expect(
      resolveSymbolTarget({
        fs: fsWithFixture(),
        files: ALL_FILES,
        pattern: parseSymbolTargetPattern("missing"),
        options: { containingLine: undefined },
      }),
    ).rejects.toBeInstanceOf(SymbolTargetNotFoundError);
  });

  it("throws ambiguity with every matching declaration candidate", async () => {
    await expect(
      resolveSymbolTarget({
        fs: fsWithFixture(),
        files: ALL_FILES,
        pattern: parseSymbolTargetPattern("parse"),
        options: { containingLine: undefined },
      }),
    ).rejects.toMatchObject({
      name: "AmbiguousSymbolTargetError",
      reason: 'symbol target "parse" is ambiguous: src/json.ts::parse, src/query.ts::parse',
    } satisfies Partial<AmbiguousSymbolTargetError>);
  });
});
