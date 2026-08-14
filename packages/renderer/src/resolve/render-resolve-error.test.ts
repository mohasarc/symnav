import { describe, expect, it } from "vitest";

import { InvalidRegexError } from "@symnav/core";

import { ResolveErrorRenderer } from "./render-resolve-error.js";

describe("ResolveErrorRenderer", () => {
  it("composes the invalid-regex message from the pattern and detail", () => {
    expect(
      ResolveErrorRenderer.render(new InvalidRegexError("[", "Unterminated character class")),
    ).toBe('Cannot answer: invalid regex "[": Unterminated character class.\n');
  });

  it("leaves unrelated errors unrendered", () => {
    expect(ResolveErrorRenderer.render(new Error("x"))).toBeUndefined();
  });
});
