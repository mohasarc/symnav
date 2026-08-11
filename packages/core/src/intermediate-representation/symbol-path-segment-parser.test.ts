import { describe, expect, it } from "vitest";

import { SymbolPathSegmentParser } from "./symbol-path-segment-parser.js";

describe("SymbolPathSegmentParser.parse", () => {
  it("returns a parsed segment", () => {
    expect(SymbolPathSegmentParser.parse("charge#2")).toEqual({
      outcome: "parsed",
      segment: { name: "charge", disambiguator: 2 },
    });
  });

  it("returns invalid segment syntax without throwing", () => {
    expect(SymbolPathSegmentParser.parse("charge#nope")).toEqual({
      outcome: "invalid",
      explanation: 'disambiguator must be a positive integer (got "nope")',
    });
  });
});
