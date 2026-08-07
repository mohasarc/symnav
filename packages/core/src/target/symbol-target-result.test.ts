import { describe, expect, it } from "vitest";

import { SymbolTargetGrammar } from "./symbol-target-pattern.js";
import { candidate } from "./symbol-target-builders.js";
import { AmbiguousSymbolTargetError, SymbolTargetNotFoundError } from "./symbol-target-result.js";

describe("SymbolTargetNotFoundError", () => {
  it("names the missing target in its reason", () => {
    const error = new SymbolTargetNotFoundError(SymbolTargetGrammar.parse("charge"));

    expect(error.reason).toBe('no symbol target "charge" found');
  });
});

describe("AmbiguousSymbolTargetError", () => {
  const pattern = SymbolTargetGrammar.parse("parse");
  const candidates = [
    candidate("src/json.ts", ["parse"], ["export function parse(input: string): JsonValue"]),
    candidate("src/query.ts", ["parse"], ["export function parse(input: URLSearchParams): Query"]),
  ];

  it("lists candidate ids in its reason", () => {
    const error = new AmbiguousSymbolTargetError(pattern, candidates);

    expect(error.reason).toBe(
      'symbol target "parse" is ambiguous: src/json.ts::parse, src/query.ts::parse',
    );
  });

  it("exposes the pattern and candidates as data", () => {
    const error = new AmbiguousSymbolTargetError(pattern, candidates);

    expect(error.pattern).toBe(pattern);
    expect(error.candidates).toBe(candidates);
  });
});
