import { describe, expect, it } from "vitest";

import type {
  Header,
  SymbolIdentity,
  SymbolOverviewNode,
  SymbolTargetCandidate,
} from "@symnav/core";
import {
  AmbiguousSymbolTargetError,
  SymbolTargetNotFoundError,
  SymbolTargetGrammar,
} from "@symnav/core";

import { SymbolTargetErrorRenderer } from "./render-symbol-target-error.js";

describe("SymbolTargetErrorRenderer", () => {
  it("renders the ambiguity statement and candidate tree exactly", () => {
    const error = new AmbiguousSymbolTargetError(SymbolTargetGrammar.parse("parse"), [
      candidate("src/json.ts", ["parse"], ["export function parse(input: string): JsonValue"]),
      candidate(
        "src/query.ts",
        ["parse"],
        ["export function parse(input: URLSearchParams): Query"],
      ),
    ]);

    expect(SymbolTargetErrorRenderer.render(error)).toBe(
      [
        'Cannot answer: symbol target "parse" is ambiguous.',
        "",
        "Candidates",
        "├── src/json.ts::parse",
        "│   export function parse(input: string): JsonValue",
        "└── src/query.ts::parse",
        "    export function parse(input: URLSearchParams): Query",
        "",
      ].join("\n"),
    );
  });

  it("prefixes every line of a wrapped signature with its candidate's glyph", () => {
    const error = new AmbiguousSymbolTargetError(SymbolTargetGrammar.parse("charge"), [
      candidate(
        "src/stripe.ts",
        ["charge"],
        ["export function charge(", "  amount: number,", "): Promise<Receipt>"],
      ),
      candidate(
        "src/paypal.ts",
        ["charge"],
        ["export function charge(", "  amount: Money,", "): Promise<Invoice>"],
      ),
    ]);

    expect(SymbolTargetErrorRenderer.render(error)).toBe(
      [
        'Cannot answer: symbol target "charge" is ambiguous.',
        "",
        "Candidates",
        "├── src/stripe.ts::charge",
        "│   export function charge(",
        "│     amount: number,",
        "│   ): Promise<Receipt>",
        "└── src/paypal.ts::charge",
        "    export function charge(",
        "      amount: Money,",
        "    ): Promise<Invoice>",
        "",
      ].join("\n"),
    );
  });

  it("leaves other symbol-target errors unrendered", () => {
    const error = new SymbolTargetNotFoundError(SymbolTargetGrammar.parse("parse"));

    expect(SymbolTargetErrorRenderer.render(error)).toBeUndefined();
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
