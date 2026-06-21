import { describe, expect, it } from "vitest";
import { isTelemetryEnabled } from "./is-telemetry-enabled.js";

describe("isTelemetryEnabled", () => {
  it.each([
    [{ SYMNAV_TELEMETRY: "0" }, false],
    [{}, true],
    [{ SYMNAV_TELEMETRY: "1" }, true],
    [{ SYMNAV_TELEMETRY: "false" }, true],
  ] as const)("returns %s for %j", (env, expected) => {
    expect(isTelemetryEnabled(env)).toBe(expected);
  });
});
