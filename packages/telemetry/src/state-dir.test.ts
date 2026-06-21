import { describe, expect, it } from "vitest";
import { resolveStateDir, usageLogPath } from "./state-dir.js";

describe("resolveStateDir", () => {
  it("uses SYMNAV_STATE_DIR when set", () => {
    expect(resolveStateDir({ SYMNAV_STATE_DIR: "/tmp/x" }, "/home/me")).toBe("/tmp/x");
  });

  it("uses the homedir symnav directory when SYMNAV_STATE_DIR is unset", () => {
    expect(resolveStateDir({}, "/home/me")).toBe("/home/me/.symnav");
  });
});

describe("usageLogPath", () => {
  it("places usage.jsonl under the state directory", () => {
    expect(usageLogPath("/state")).toBe("/state/usage.jsonl");
  });
});
