import { describe, expect, it } from "vitest";

import { isPositiveInteger } from "./is-positive-integer.js";

describe("isPositiveInteger", () => {
  it.each([1, 2, 100])("accepts %s", (value) => {
    expect(isPositiveInteger(value)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (value) => {
    expect(isPositiveInteger(value)).toBe(false);
  });
});
