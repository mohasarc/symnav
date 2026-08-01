import { describe, expect, it } from "vitest";

import { parseSymbolTargetPattern, symbolTargetMatches } from "./symbol-target-pattern.js";
import { InvalidSymbolIdError } from "../intermediate-representation/canonical-identity.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";

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

  it("parses a leaf disambiguator", () => {
    expect(parseSymbolTargetPattern("src/foo.ts::Bar::baz#2")).toEqual({
      raw: "src/foo.ts::Bar::baz#2",
      fileSuffix: "src/foo.ts",
      segmentSuffix: [{ name: "Bar" }, { name: "baz", disambiguator: 2 }],
    });
  });

  it("parses an ancestor disambiguator", () => {
    expect(parseSymbolTargetPattern("src/foo.ts::Bar#1::baz")).toEqual({
      raw: "src/foo.ts::Bar#1::baz",
      fileSuffix: "src/foo.ts",
      segmentSuffix: [{ name: "Bar", disambiguator: 1 }, { name: "baz" }],
    });
  });

  it("parses a leading-`#` name as a plain name, not a disambiguator", () => {
    expect(parseSymbolTargetPattern("src/foo.ts::C::#secret")).toEqual({
      raw: "src/foo.ts::C::#secret",
      fileSuffix: "src/foo.ts",
      segmentSuffix: [{ name: "C" }, { name: "#secret" }],
    });
  });

  it("parses a private field carrying a trailing disambiguator", () => {
    expect(parseSymbolTargetPattern("src/foo.ts::C::#secret#2")).toEqual({
      raw: "src/foo.ts::C::#secret#2",
      fileSuffix: "src/foo.ts",
      segmentSuffix: [{ name: "C" }, { name: "#secret", disambiguator: 2 }],
    });
  });

  it("rejects empty input", () => {
    expect(() => parseSymbolTargetPattern("")).toThrow(InvalidSymbolIdError);
  });

  it("rejects empty interior segments (`a::::b`)", () => {
    expect(() => parseSymbolTargetPattern("a::::b")).toThrow(InvalidSymbolIdError);
  });

  it("rejects trailing empty segment (`a::b::`)", () => {
    expect(() => parseSymbolTargetPattern("a::b::")).toThrow(InvalidSymbolIdError);
  });

  it("rejects zero disambiguator (`a::b#0`)", () => {
    expect(() => parseSymbolTargetPattern("a::b#0")).toThrow(InvalidSymbolIdError);
  });

  it("rejects negative disambiguator (`a::b#-1`)", () => {
    expect(() => parseSymbolTargetPattern("a::b#-1")).toThrow(InvalidSymbolIdError);
  });

  it("rejects non-numeric disambiguator (`a::b#abc`)", () => {
    expect(() => parseSymbolTargetPattern("a::b#abc")).toThrow(InvalidSymbolIdError);
  });
});

describe("parseSymbolTargetPattern error reasons", () => {
  function reasonOf(thrower: () => unknown): string {
    try {
      thrower();
    } catch (err) {
      if (err instanceof InvalidSymbolIdError) return err.reason;
      throw err;
    }
    throw new Error("expected InvalidSymbolIdError to be thrown");
  }

  it("names empty input", () => {
    expect(reasonOf(() => parseSymbolTargetPattern(""))).toContain("empty input");
  });

  it("names an empty path segment", () => {
    expect(reasonOf(() => parseSymbolTargetPattern("a::::b"))).toContain(
      'empty path segment between "::" separators',
    );
  });

  it("names a non-numeric disambiguator and echoes the offending text", () => {
    const reason = reasonOf(() => parseSymbolTargetPattern("a::b#abc"));
    expect(reason).toContain("disambiguator must be a positive integer");
    expect(reason).toContain('"abc"');
  });

  it("echoes the raw offending input", () => {
    expect(reasonOf(() => parseSymbolTargetPattern("a::b#abc"))).toContain("a::b#abc");
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

function identity(file: string, ...names: readonly string[]): SymbolIdentity {
  return { file, segments: names.map((name) => ({ name })) };
}
