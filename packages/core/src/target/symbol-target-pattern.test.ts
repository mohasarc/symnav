import { describe, expect, it } from "vitest";

import { parseSymbolTargetPattern, symbolTargetMatches } from "./symbol-target-pattern.js";
import { AmbiguousSymbolTargetError, type SymbolTargetCandidate } from "./symbol-target-result.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import type { Signature, SymbolDecl } from "../intermediate-representation/types.js";

describe("parseSymbolTargetPattern", () => {
  it("parses a bare name as a segment suffix", () => {
    expect(parseSymbolTargetPattern("charge")).toEqual({
      raw: "charge",
      fileSuffix: undefined,
      segmentSuffix: [{ name: "charge" }],
    });
  });

  it("parses a file suffix and final segment", () => {
    expect(parseSymbolTargetPattern("orders.ts::charge")).toEqual({
      raw: "orders.ts::charge",
      fileSuffix: "orders.ts",
      segmentSuffix: [{ name: "charge" }],
    });
  });

  it("parses a full canonical id as a target pattern", () => {
    expect(parseSymbolTargetPattern("src/orders.ts::PaymentProcessor::charge")).toEqual({
      raw: "src/orders.ts::PaymentProcessor::charge",
      fileSuffix: "src/orders.ts",
      segmentSuffix: [{ name: "PaymentProcessor" }, { name: "charge" }],
    });
  });
});

describe("symbolTargetMatches", () => {
  it("matches by path suffix and segment suffix together", () => {
    const pattern = parseSymbolTargetPattern("payments/stripe.ts::StripeProvider::charge");

    expect(
      symbolTargetMatches(pattern, identity("src/payments/stripe.ts", "StripeProvider", "charge")),
    ).toBe(true);
    expect(
      symbolTargetMatches(pattern, identity("src/payments/paypal.ts", "PaypalProvider", "charge")),
    ).toBe(false);
  });

  it("matches bare file suffixes only at path segment boundaries", () => {
    const pattern = parseSymbolTargetPattern("foo.ts::parse");

    expect(symbolTargetMatches(pattern, identity("src/foo.ts", "parse"))).toBe(true);
    expect(symbolTargetMatches(pattern, identity("src/notfoo.ts", "parse"))).toBe(false);
  });

  it("matches multi-segment file suffixes only at path segment boundaries", () => {
    const pattern = parseSymbolTargetPattern("pattern/json.ts::parse");

    expect(symbolTargetMatches(pattern, identity("src/pattern/json.ts", "parse"))).toBe(true);
    expect(symbolTargetMatches(pattern, identity("src/otherpattern/json.ts", "parse"))).toBe(false);
  });

  it("matches nested segment suffixes without a file suffix", () => {
    const pattern = parseSymbolTargetPattern("PaymentProcessor::charge");

    expect(
      symbolTargetMatches(pattern, identity("src/orders.ts", "PaymentProcessor", "charge")),
    ).toBe(true);
    expect(
      symbolTargetMatches(pattern, identity("src/orders.ts", "PaymentProcessor", "refund")),
    ).toBe(false);
  });

  it("matches full canonical ids exactly as suffix patterns", () => {
    const pattern = parseSymbolTargetPattern("src/orders.ts::PaymentProcessor::charge");

    expect(
      symbolTargetMatches(pattern, identity("src/orders.ts", "PaymentProcessor", "charge")),
    ).toBe(true);
  });
});

describe("AmbiguousSymbolTargetError", () => {
  it("renders full candidate ids and signatures", () => {
    const pattern = parseSymbolTargetPattern("parse");
    const error = new AmbiguousSymbolTargetError(pattern, [
      candidate("src/json.ts", ["parse"], ["export function parse(input: string): JsonValue"]),
      candidate(
        "src/query.ts",
        ["parse"],
        ["export function parse(input: URLSearchParams): Query"],
      ),
    ]);

    expect(error.render()).toContain('Cannot answer: symbol target "parse" is ambiguous.');
    expect(error.render()).toContain("src/json.ts::parse");
    expect(error.render()).toContain("export function parse(input: string): JsonValue");
    expect(error.render()).toContain("src/query.ts::parse");
    expect(error.render()).toContain("export function parse(input: URLSearchParams): Query");
  });
});

function identity(file: string, ...names: readonly string[]): SymbolIdentity {
  return { file, segments: names.map((name) => ({ name })) };
}

function candidate(
  file: string,
  names: readonly string[],
  signatureLines: readonly string[],
): SymbolTargetCandidate {
  const signature: Signature = { startLine: 1, lines: signatureLines };
  const symbol: SymbolDecl = {
    type: "symbol",
    identity: identity(file, ...names),
    kind: { role: "callable", nativeLabel: "function" },
    range: { startLine: 1, endLine: 1 },
    header: signature,
    children: [],
  };
  return { symbol, canonicalId: `${file}::${names.join("::")}`, signature };
}
