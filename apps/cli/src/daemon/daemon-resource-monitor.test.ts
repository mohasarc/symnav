import { describe, expect, it } from "vitest";
import { daemonMemoryCapBytes } from "./daemon-resource-monitor.js";

describe("daemonMemoryCapBytes", () => {
  it("uses one quarter of total RAM within fixed bounds", () => {
    const mebibyte = 1024 * 1024;
    expect(daemonMemoryCapBytes(512 * mebibyte)).toBe(256 * mebibyte);
    expect(daemonMemoryCapBytes(8 * 1024 * mebibyte)).toBe(2 * 1024 * mebibyte);
    expect(daemonMemoryCapBytes(64 * 1024 * mebibyte)).toBe(4 * 1024 * mebibyte);
  });
});
