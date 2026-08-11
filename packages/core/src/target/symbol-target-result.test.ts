import { describe, expect, expectTypeOf, it } from "vitest";

import { candidate } from "./symbol-target-builders.js";
import {
  AmbiguousSymbolTargetError,
  InvalidSymbolTargetError,
  SymbolTargetLineMismatchError,
  SymbolTargetNotFoundError,
} from "./symbol-target-result.js";

describe("InvalidSymbolTargetError", () => {
  it("keeps parse failure details out of the public error contract", () => {
    type ExposesParseFailure = InvalidSymbolTargetError extends {
      readonly explanation: string;
      readonly raw: string;
    }
      ? true
      : false;

    expectTypeOf<ExposesParseFailure>().toEqualTypeOf<false>();
  });
});

describe("SymbolTargetNotFoundError", () => {
  it("names the missing target in its reason", () => {
    const error = new SymbolTargetNotFoundError("charge");

    expect(error.reason).toBe('no symbol target "charge" found');
    expect(error).toEqual(expect.objectContaining({ rawTarget: "charge" }));
    expect(error).not.toHaveProperty("pattern");
  });
});

describe("SymbolTargetLineMismatchError", () => {
  it("names the target and requested line in its reason", () => {
    const error = new SymbolTargetLineMismatchError("helper", 99);

    expect(error.reason).toBe('no symbol target "helper" matching line 99');
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

  it("retains only raw input and deterministic candidates", () => {
    const error = new AmbiguousSymbolTargetError("parse", candidates);

    expect(error.rawTarget).toBe("parse");
    expect(error.candidates).toBe(candidates);
    expect(error).not.toHaveProperty("pattern");
  });
});
