import { describe, expect, it } from "vitest";

import { UserFacingError } from "../errors.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import {
  InvalidRegexError,
  NoSupportedFilesError,
  SymbolNotFoundError,
  UnsupportedFileError,
} from "./errors.js";

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

describe("NoSupportedFilesError", () => {
  it("is a UserFacingError", () => {
    expect(new NoSupportedFilesError()).toBeInstanceOf(UserFacingError);
  });

  it("carries its class name", () => {
    expect(new NoSupportedFilesError().name).toBe("NoSupportedFilesError");
  });

  it("renders a reason naming the missing backend support", () => {
    expect(new NoSupportedFilesError().reason).toBe(
      "workspace contains no files supported by any language backend",
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

describe("InvalidRegexError", () => {
  it("is a UserFacingError", () => {
    expect(new InvalidRegexError("resolve", "[", "Unterminated character class")).toBeInstanceOf(
      UserFacingError,
    );
  });

  it("exposes the subject, pattern, and detail as fields", () => {
    const err = new InvalidRegexError("resolve", "[", "Unterminated character class");
    expect(err.subject).toBe("resolve");
    expect(err.pattern).toBe("[");
    expect(err.detail).toBe("Unterminated character class");
  });

  it("renders a reason containing the pattern and detail", () => {
    expect(new InvalidRegexError("resolve", "[", "Unterminated character class").reason).toBe(
      'invalid resolve regex "[": Unterminated character class',
    );
  });
});
