import { describe, expect, it } from "vitest";

import { UserFacingError } from "../errors.js";
import { SymbolNotFoundError, UnsupportedFileError } from "./errors.js";

describe("UnsupportedFileError", () => {
  it("is a UserFacingError", () => {
    expect(new UnsupportedFileError("README.md")).toBeInstanceOf(UserFacingError);
  });

  it("renders a reason citing the extension and input path", () => {
    expect(new UnsupportedFileError("README.md").reason).toBe("cannot read .md files (README.md)");
  });
});

describe("SymbolNotFoundError", () => {
  const identity = {
    file: "src/payments/PaymentProcessor.ts",
    segments: [{ name: "PaymentProcessor" }, { name: "charge" }],
  };

  it("is a UserFacingError", () => {
    expect(new SymbolNotFoundError(identity)).toBeInstanceOf(UserFacingError);
  });

  it("renders a reason containing the formatted canonical ID", () => {
    expect(new SymbolNotFoundError(identity).reason).toBe(
      "no symbol src/payments/PaymentProcessor.ts::PaymentProcessor::charge found",
    );
  });
});
