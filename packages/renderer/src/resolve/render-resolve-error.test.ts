import { describe, expect, it } from "vitest";

import { InvalidResolveRegexError } from "@symnav/core";

import { ResolveErrorRenderer } from "./render-resolve-error.js";

describe("ResolveErrorRenderer", () => {
  it("composes the invalid-regex message from the pattern and detail", () => {
    expect(
      ResolveErrorRenderer.render(
        new InvalidResolveRegexError("[", "Unterminated character class"),
      ),
    ).toBe('Cannot answer: invalid resolve regex "[": Unterminated character class.\n');
  });

  it("leaves unrelated errors unrendered", () => {
    expect(ResolveErrorRenderer.render(new Error("x"))).toBeUndefined();
  });
});
