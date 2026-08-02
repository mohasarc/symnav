import { describe, expect, it } from "vitest";

import { compileResolveRegex } from "./compile-resolve-regex.js";
import { InvalidResolveRegexError } from "./errors.js";

describe("compileResolveRegex", () => {
  it("returns a RegExp preserving the pattern source", () => {
    expect(compileResolveRegex("^to[A-Z].*").source).toBe("^to[A-Z].*");
  });

  it("throws InvalidResolveRegexError with the V8 prefix stripped from the detail", () => {
    let caught: unknown;
    try {
      compileResolveRegex("[");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidResolveRegexError);
    const invalid = caught as InvalidResolveRegexError;
    expect(invalid.pattern).toBe("[");
    expect(invalid.detail).toBe("Unterminated character class");
  });
});
