import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonMemoryCapBytes, DaemonResourceMonitor } from "./daemon-resource-monitor.js";

describe("daemonMemoryCapBytes", () => {
  it("uses one quarter of total RAM within fixed bounds", () => {
    const mebibyte = 1024 * 1024;
    expect(daemonMemoryCapBytes(512 * mebibyte)).toBe(256 * mebibyte);
    expect(daemonMemoryCapBytes(8 * 1024 * mebibyte)).toBe(2 * 1024 * mebibyte);
    expect(daemonMemoryCapBytes(64 * 1024 * mebibyte)).toBe(4 * 1024 * mebibyte);
  });
});

describe("DaemonResourceMonitor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops once when RSS breaches the cap", async () => {
    let rss = 99;
    const onExceeded = vi.fn(async () => undefined);
    const monitor = new DaemonResourceMonitor({
      memoryCapBytes: 100,
      intervalMs: 10,
      residentMemoryBytes: () => rss,
      onExceeded,
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(onExceeded).not.toHaveBeenCalled();
    rss = 101;
    await vi.advanceTimersByTimeAsync(10);
    expect(onExceeded).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20);
    expect(onExceeded).toHaveBeenCalledOnce();
  });
});
