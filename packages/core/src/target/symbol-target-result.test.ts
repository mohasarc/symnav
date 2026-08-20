import { describe, expect, it } from "vitest";

import { candidate } from "./symbol-target-builders.js";
import {
  AmbiguousSymbolTargetError,
  SymbolTargetLineMismatchError,
  SymbolTargetNotFoundError,
} from "./symbol-target-result.js";

describe("SymbolTargetNotFoundError", () => {
  it("names the missing target in its reason", () => {
    const error = new SymbolTargetNotFoundError("charge");

    expect(error.reason).toBe('no symbol target "charge" found');
    expect(error.rawTarget).toBe("charge");
  });
});

describe("SymbolTargetLineMismatchError", () => {
  it("names the raw target and requested line", () => {
    const error = new SymbolTargetLineMismatchError("charge", 99);

    expect(error.reason).toBe('no symbol target "charge" matching line 99');
    expect(error.rawTarget).toBe("charge");
    expect(error.line).toBe(99);
  });
});

describe("AmbiguousSymbolTargetError", () => {
  const candidates = [
    candidate("src/json.ts", ["parse"], ["export function parse(input: string): JsonValue"]),
    candidate("src/query.ts", ["parse"], ["export function parse(input: URLSearchParams): Query"]),
  ];

  it("lists candidate ids in its reason", () => {
    const error = new AmbiguousSymbolTargetError("parse", candidates);

    expect(error.reason).toBe(
      'symbol target "parse" is ambiguous: src/json.ts::parse, src/query.ts::parse',
    );
  });

  it("exposes the pattern and candidates as data", () => {
    const error = new AmbiguousSymbolTargetError("parse", candidates);

    expect(error.rawTarget).toBe("parse");
    expect(error.candidates).toBe(candidates);
  });
});
