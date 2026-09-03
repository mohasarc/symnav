import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { usageLogPath } from "./state-dir.js";

describe("usageLogPath", () => {
  it("places usage.jsonl under the state directory", () => {
    expect(usageLogPath("/state")).toBe(join("/state", "usage.jsonl"));
  });
});
