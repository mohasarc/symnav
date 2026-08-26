import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DAEMON_BENCHMARK_WARM_REPETITIONS } from "./daemon-benchmark-gate.js";
import { DaemonScaleBenchmarkHarness } from "./daemon-scale-benchmark-harness.js";
import { DaemonWorkspaceProfileValidator } from "./daemon-workspace-profile.js";

describe("DaemonScaleBenchmarkHarness", () => {
  it("runs one cold baseline and nine warm fixed-suite repetitions with aggregate evidence", async () => {
    const reviewed = JSON.parse(
      readFileSync(new URL("./profiles/daemon-workspace-1x.v1.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const profile = DaemonWorkspaceProfileValidator.parse({
      ...reviewed,
      visibleTypeScriptFiles: 12,
      packageCount: 3,
      configCount: 4,
      projectReferenceCount: 3,
    });

    const artifact = await new DaemonScaleBenchmarkHarness({
      profile,
      scale: 1,
      generatorVersion: "1.0.0",
      seed: "acceptance-seed",
    }).run();

    expect(artifact.samples).toHaveLength(7 * DAEMON_BENCHMARK_WARM_REPETITIONS);
    expect(artifact.largeResponseBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(artifact.responsePeakBytes).toBe(artifact.largeResponseBytes);
    expect(artifact.busyStatusObserved).toBe(true);
    expect(artifact.processRssPeakBytes).toBeGreaterThan(0);
    expect(artifact.processRssPeakBytes).toBeLessThan(artifact.resourcePolicy.hardProcessRssBytes);
    expect(artifact.commandStatistics).toEqual(
      expect.objectContaining({
        overview: expect.any(Object),
        resolve: expect.any(Object),
        def: expect.any(Object),
        refs: expect.any(Object),
        context: expect.any(Object),
        graph: expect.any(Object),
        stats: expect.any(Object),
      }),
    );
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      scale: 1,
      parity: true,
      freshness: true,
      statusResponsive: true,
      continuity: true,
      exactlyOnceTelemetry: true,
      resourcesWithinPolicy: true,
      spoolsCleaned: true,
      failures: [],
    });
  }, 120_000);
});
