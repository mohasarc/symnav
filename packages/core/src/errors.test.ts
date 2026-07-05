import { describe, expect, it } from "vitest";

import { UserFacingError } from "./errors.js";

class TestUserFacingError extends UserFacingError {
  get reason(): string {
    return "test failure";
  }
}

describe("UserFacingError", () => {
  it("renders the default Cannot answer message", () => {
    expect(new TestUserFacingError().render()).toBe("Cannot answer: test failure.\n");
  });
});
