import { describe, expect, it } from "vitest";

import { GraphDepthExceededError, InvalidGraphRequestError } from "./errors.js";

describe("GraphDepthExceededError", () => {
  it("renders the graph depth refusal text", () => {
    expect(new GraphDepthExceededError(12).render()).toBe(
      "Cannot run graph with depth 12.\n" +
        "Maximum supported depth is 5.\n" +
        "\n" +
        "To continue exploration:\n" +
        "1. Run with depth 5.\n" +
        "2. Pick a leaf symbol from the output.\n" +
        "3. Run graph again from that symbol.\n",
    );
  });
});

describe("InvalidGraphRequestError", () => {
  it("carries the request explanation as its reason", () => {
    const err = new InvalidGraphRequestError("choose incoming or outgoing, not both");

    expect(err.reason).toBe("choose incoming or outgoing, not both");
  });
});
