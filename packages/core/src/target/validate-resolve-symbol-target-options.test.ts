import { describe, expect, it } from "vitest";

import {
  InvalidSymbolTargetRequestError,
  validateResolveSymbolTargetOptions,
} from "./validate-resolve-symbol-target-options.js";

describe("validateResolveSymbolTargetOptions", () => {
  it("accepts an undefined containingLine", () => {
    expect(() => validateResolveSymbolTargetOptions({ containingLine: undefined })).not.toThrow();
  });

  it.each([1, 7, 4096])("accepts positive integer containingLine %d", (containingLine) => {
    expect(() => validateResolveSymbolTargetOptions({ containingLine })).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects containingLine %d", (containingLine) => {
    expect(() => validateResolveSymbolTargetOptions({ containingLine })).toThrow(
      InvalidSymbolTargetRequestError,
    );
  });

  it("echoes the rejected value in the reason", () => {
    const thrown = ((): unknown => {
      try {
        validateResolveSymbolTargetOptions({ containingLine: 1.5 });
        return undefined;
      } catch (err) {
        return err;
      }
    })();

    expect(thrown).toBeInstanceOf(InvalidSymbolTargetRequestError);
    expect((thrown as InvalidSymbolTargetRequestError).reason).toBe(
      "containingLine must be a positive integer, got 1.5",
    );
  });
});
