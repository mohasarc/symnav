import { describe, expect, it } from "vitest";

import { compileRegex } from "./compile-regex.js";
import { InvalidRegexError, type RegexSubject } from "./errors.js";

describe("compileRegex", () => {
  it.each<RegexSubject>(["resolve", "symbol target"])(
    "normalizes a valid %s pattern through JavaScript regex compilation",
    (subject) => {
      expect(compileRegex("^to[A-Z].*", subject).source).toBe("^to[A-Z].*");
    },
  );

  it.each<RegexSubject>(["resolve", "symbol target"])(
    "reports an invalid %s pattern with closed product vocabulary",
    (subject) => {
      let caught: unknown;
      try {
        compileRegex("[", subject);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(InvalidRegexError);
      const invalid = caught as InvalidRegexError;
      expect(invalid.subject).toBe(subject);
      expect(invalid.pattern).toBe("[");
      expect(invalid.detail).toBe("Unterminated character class");
      expect(invalid.reason).toBe(`invalid ${subject} regex "[": Unterminated character class`);
    },
  );
});
