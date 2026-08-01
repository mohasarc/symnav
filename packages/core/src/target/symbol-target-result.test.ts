import { describe, expect, it } from "vitest";

import { parseSymbolTargetPattern } from "./symbol-target-pattern.js";
import {
  AmbiguousSymbolTargetError,
  SymbolTargetNotFoundError,
  type SymbolTargetCandidate,
} from "./symbol-target-result.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import type { Header } from "../intermediate-representation/types.js";
import type { SymbolOverviewNode } from "../intermediate-representation/overview-tree.js";

describe("SymbolTargetNotFoundError", () => {
  it("names the missing target in its reason", () => {
    const error = new SymbolTargetNotFoundError(parseSymbolTargetPattern("charge"));

    expect(error.reason).toBe('no symbol target "charge" found');
  });
});

describe("AmbiguousSymbolTargetError", () => {
  const pattern = parseSymbolTargetPattern("parse");
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

function identity(file: string, ...names: readonly string[]): SymbolIdentity {
  return { file, segments: names.map((name) => ({ name })) };
}

function candidate(
  file: string,
  names: readonly string[],
  headerLines: readonly string[],
): SymbolTargetCandidate {
  const header: Header = { startLine: 1, lines: headerLines };
  const symbol: SymbolOverviewNode = {
    type: "symbol",
    identity: identity(file, ...names),
    kind: { role: "callable", nativeLabel: "function" },
    range: { startLine: 1, endLine: 1 },
    header,
    children: [],
  };
  return { symbol, canonicalId: `${file}::${names.join("::")}`, header };
}
