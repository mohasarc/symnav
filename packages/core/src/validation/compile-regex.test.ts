import { describe, expect, it } from "vitest";

import { UserFacingError } from "../errors.js";
import { InvalidRegexError, compileRegex } from "./compile-regex.js";

describe("compileRegex", () => {
  it("returns a case-sensitive regular expression preserving the pattern source", () => {
    const expression = compileRegex("^to[A-Z].*");

    expect(expression.source).toBe("^to[A-Z].*");
    expect(expression.flags).toBe("");
    expect(expression.test("toOrder")).toBe(true);
    expect(expression.test("toorder")).toBe(false);
  });

  it("throws InvalidRegexError with rejected text and the engine prefix removed", () => {
    let caught: unknown;
    try {
      compileRegex("[");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidRegexError);
    const invalid = caught as InvalidRegexError;
    expect(invalid.pattern).toBe("[");
    expect(invalid.detail).toBe("Unterminated character class");
  });
});

describe("InvalidRegexError", () => {
  it("is a UserFacingError", () => {
    expect(new InvalidRegexError("[", "Unterminated character class")).toBeInstanceOf(
      UserFacingError,
    );
  });

  it("exposes the pattern and detail as fields", () => {
    const error = new InvalidRegexError("[", "Unterminated character class");

    expect(error.pattern).toBe("[");
    expect(error.detail).toBe("Unterminated character class");
  });

  it("uses shared regex vocabulary", () => {
    expect(new InvalidRegexError("[", "Unterminated character class").reason).toBe(
      'invalid regex "[": Unterminated character class',
    );
  });
});
