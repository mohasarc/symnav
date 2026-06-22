import { describe, expect, it } from "vitest";
import { isTelemetryEnabled } from "./is-telemetry-enabled.js";

describe("isTelemetryEnabled", () => {
  it.each([
    [{ SYMNAV_TELEMETRY: "0" }, false],
    [{ SYMNAV_TELEMETRY: "false" }, false],
    [{ SYMNAV_TELEMETRY: "off" }, false],
    [{ SYMNAV_TELEMETRY: "no" }, false],
    [{ SYMNAV_TELEMETRY: "FALSE" }, false],
    [{ SYMNAV_TELEMETRY: " Off " }, false],
    [{}, true],
    [{ SYMNAV_TELEMETRY: "1" }, true],
    [{ SYMNAV_TELEMETRY: "true" }, true],
    [{ SYMNAV_TELEMETRY: "on" }, true],
    [{ SYMNAV_TELEMETRY: "yes" }, true],
    [{ SYMNAV_TELEMETRY: "YES" }, true],
    [{ SYMNAV_TELEMETRY: "" }, true],
    [{ SYMNAV_TELEMETRY: "maybe" }, true],
  ] as const)("returns %s for %j", (env, expected) => {
    expect(isTelemetryEnabled(env)).toBe(expected);
  });
});
