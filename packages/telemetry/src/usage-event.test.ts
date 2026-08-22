import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./usage-event.js";

describe("usage event schema", () => {
  it("uses schema v2 for explicit execution modes", () => {
    expect(SCHEMA_VERSION).toBe(2);
  });
});
