import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as telemetry from "./index.js";
import { usageLogPath } from "./state-dir.js";

describe("usageLogPath", () => {
  it("places usage.jsonl under the state directory", () => {
    expect(usageLogPath("/state")).toBe(join("/state", "usage.jsonl"));
  });

  it("leaves shared state directory resolution to the CLI", () => {
    expect(telemetry).not.toHaveProperty("resolveStateDir");
    expect(telemetry).not.toHaveProperty("canonicalStateDir");
  });
});
