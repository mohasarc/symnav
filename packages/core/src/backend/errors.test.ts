import { describe, expect, it } from "vitest";

import { UserFacingError } from "../errors.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import { SymbolNotFoundError, UnsupportedFileError } from "./errors.js";

describe("UnsupportedFileError", () => {
  it("is a UserFacingError", () => {
    expect(new UnsupportedFileError("README.md")).toBeInstanceOf(UserFacingError);
  });

  it("renders a reason citing the extension and input path", () => {
    expect(new UnsupportedFileError("README.md").reason).toBe("cannot read .md files (README.md)");
  });

  it("renders a specific reason for extensionless files", () => {
    expect(new UnsupportedFileError("README").reason).toBe(
      "README has no file extension; expected a source file",
    );
  });
});

describe("SymbolNotFoundError", () => {
  const identity: SymbolIdentity = {
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
