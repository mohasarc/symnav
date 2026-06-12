import { describe, expect, it } from "vitest";

import { UserFacingError } from "../errors.js";
import { InvalidPageRequestError, PageOutOfRangeError } from "./errors.js";

describe("InvalidPageRequestError", () => {
  it("is a UserFacingError", () => {
    expect(new InvalidPageRequestError("page must be a positive integer")).toBeInstanceOf(
      UserFacingError,
    );
  });

  it("renders a reason carrying the detail", () => {
    expect(new InvalidPageRequestError("page must be a positive integer").reason).toBe(
      "invalid page request: page must be a positive integer",
    );
  });
});

describe("PageOutOfRangeError", () => {
  it("is a UserFacingError", () => {
    expect(new PageOutOfRangeError(5, 3)).toBeInstanceOf(UserFacingError);
  });

  it("renders a reason naming the requested page and page count", () => {
    expect(new PageOutOfRangeError(5, 3).reason).toBe("page 5 is out of range (1-3)");
  });
});
