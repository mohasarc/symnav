import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./usage-event.js";

describe("usage event schema", () => {
  it("exports a positive integer schema version", () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
