import { describe, expect, it } from "vitest";
import { DaemonBenchmarkHarness, DaemonBenchmarkTarget } from "./daemon-benchmark-harness.js";

describe("daemon benchmark harness", () => {
  it("proves one cold project load and a no-op warm refresh across 2,000 files", async () => {
    const measurement = await new DaemonBenchmarkHarness(2_000).run();

    expect(measurement.fileCount).toBe(2_000);
    expect(measurement.counts).toEqual({
      projectLoads: 1,
      snapshots: 2,
      refreshes: 2,
      sourceReads: 2_000,
      extractions: 2_000,
    });
    expect(measurement.refreshes).toEqual([
      { added: 2_000, changed: 0, removed: 0, unchanged: 0 },
      { added: 0, changed: 0, removed: 0, unchanged: 2_000 },
    ]);
    expect(measurement.firstResolveMs).toBeGreaterThanOrEqual(0);
    expect(measurement.secondResolveMs).toBeGreaterThanOrEqual(0);
    expect(measurement.target).toEqual(
      new DaemonBenchmarkTarget().compare(measurement.firstResolveMs, measurement.secondResolveMs),
    );
  }, 30_000);

  it("derives non-gating target comparisons from both full-command timings", () => {
    const target = new DaemonBenchmarkTarget(75, 3);

    expect(target.compare(300, 100)).toEqual({
      secondResolveMs: 75,
      minimumFirstToSecondRatio: 3,
      secondResolveMet: false,
      firstToSecondRatioMet: true,
      wallClockGated: false,
    });
    expect(target.compare(100, 50)).toEqual({
      secondResolveMs: 75,
      minimumFirstToSecondRatio: 3,
      secondResolveMet: true,
      firstToSecondRatioMet: false,
      wallClockGated: false,
    });
  });
});
