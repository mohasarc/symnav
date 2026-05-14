import { describe, expect, it } from "vitest";

import { UserFacingError } from "../errors.js";
import { UnsupportedFileError } from "./errors.js";

describe("UnsupportedFileError", () => {
  it("is a UserFacingError", () => {
    expect(new UnsupportedFileError("README.md")).toBeInstanceOf(UserFacingError);
  });

  it("renders a reason citing the extension and input path", () => {
    expect(new UnsupportedFileError("README.md").reason).toBe(
      "cannot read .md files (README.md)",
    );
  });
});
