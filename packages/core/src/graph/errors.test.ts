import { describe, expect, it } from "vitest";

import { GraphDepthExceededError, InvalidGraphRequestError } from "./errors.js";

describe("GraphDepthExceededError", () => {
  it("refuses with the maximum depth and the way to continue", () => {
    expect(new GraphDepthExceededError(12).render()).toBe(
      "Cannot answer: --depth 12 exceeds the maximum of 5; run with --depth 5, then run graph again from a leaf symbol.\n",
    );
  });
});

describe("InvalidGraphRequestError", () => {
  it("carries the request explanation as its reason", () => {
    const err = new InvalidGraphRequestError("choose incoming or outgoing, not both");

    expect(err.reason).toBe("choose incoming or outgoing, not both");
  });
});
