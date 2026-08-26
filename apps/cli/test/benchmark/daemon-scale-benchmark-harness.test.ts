import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_BENCHMARK_WARM_REPETITIONS } from "./daemon-benchmark-gate.js";
import {
  BenchmarkSampleEvidence,
  DaemonBenchmarkDiagnostics,
  DaemonBenchmarkPhaseStatistics,
  DaemonScaleBenchmarkHarness,
} from "./daemon-scale-benchmark-harness.js";
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
    expect(artifact.spoolPeakBytes).toBeGreaterThan(8 * 1024 * 1024);
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

  it("rejects a fixed invocation whose diagnostic is masked by later operation evidence", () => {
    const logPath = TestDiagnostics.withMissingOverviewAndLaterResolve();
    const samples = Array.from({ length: 9 }, (_, repetition) =>
      BenchmarkSampleEvidence.from(
        "overview",
        repetition,
        { status: 0, stdout: "benchmarkHub", stderr: "" },
        { status: 0, stdout: "benchmarkHub", stderr: "" },
        10,
        { argv: ["overview", "target.ts"], expectNonEmpty: true },
      ),
    );

    const diagnostics = DaemonBenchmarkDiagnostics.read(logPath);
    const enriched = diagnostics.enrich(samples);

    expect(enriched.filter((sample) => sample.serviceMsExcludingQueue === 10)).toHaveLength(1);
    expect(diagnostics.complete(enriched)).toBe(false);
  });

  it("rejects a missing fixed invocation terminal masked by a same-command duplicate", () => {
    const logPath = TestDiagnostics.withDuplicatedAndMissingOverviewTerminal();
    const samples = Array.from({ length: 9 }, (_, repetition) =>
      BenchmarkSampleEvidence.from(
        "overview",
        repetition,
        { status: 0, stdout: "benchmarkHub", stderr: "" },
        { status: 0, stdout: "benchmarkHub", stderr: "" },
        10,
        { argv: ["overview", "target.ts"], expectNonEmpty: true },
      ),
    );

    const diagnostics = DaemonBenchmarkDiagnostics.read(logPath);
    const enriched = diagnostics.enrich(samples);

    expect(diagnostics.complete(enriched)).toBe(false);
  });

  it("rejects a missing fixed telemetry event masked by a same-command duplicate", () => {
    const event = { command: "overview", executionMode: "warm" } satisfies Record<string, unknown>;

    expect(BenchmarkSampleEvidence.telemetryMatched([], [event, event], "overview")).toBe(false);
    expect(BenchmarkSampleEvidence.telemetryMatched([], [], "overview")).toBe(false);
    expect(BenchmarkSampleEvidence.telemetryMatched([], [event], "overview")).toBe(true);
  });

  it.each([
    {
      command: "context" as const,
      stdout:
        '{"identity":"benchmarkHub","callers":{"sortedEdges":[],"omittedCertainEdgeCount":0},"callees":{"sortedEdges":[],"omittedCertainEdgeCount":0}}',
      expectation: { kind: "context" as const, callers: 28, callees: 1, history: 1 },
    },
    {
      command: "refs" as const,
      stdout: '{"identity":"benchmarkHub","total":252}',
      expectation: { kind: "references" as const, total: 84 },
    },
  ])("rejects untruthful structured $command evidence", ({ command, stdout, expectation }) => {
    const evidence = BenchmarkSampleEvidence.from(
      command,
      0,
      { status: 0, stdout, stderr: "" },
      { status: 0, stdout, stderr: "" },
      10,
      { argv: [command, "target"], expectNonEmpty: true, expectation },
    );

    expect(evidence.nonEmpty).toBe(false);
  });

  it("rejects malformed overview, stats, and empty context history from fixed-suite evidence", () => {
    const invalid = [
      BenchmarkSampleEvidence.from(
        "overview",
        0,
        { status: 0, stdout: '{"entries":[]}', stderr: "" },
        { status: 0, stdout: '{"entries":[]}', stderr: "" },
        10,
        {
          argv: ["overview", "target.ts", "--json"],
          expectNonEmpty: true,
          expectation: { kind: "overview", symbols: 5 },
        },
      ),
      BenchmarkSampleEvidence.from(
        "context",
        0,
        {
          status: 0,
          stdout:
            '{"callers":{"sortedEdges":[],"omittedCertainEdgeCount":28},"callees":{"sortedEdges":[],"omittedCertainEdgeCount":1},"history":[]}',
          stderr: "",
        },
        {
          status: 0,
          stdout:
            '{"callers":{"sortedEdges":[],"omittedCertainEdgeCount":28},"callees":{"sortedEdges":[],"omittedCertainEdgeCount":1},"history":[]}',
          stderr: "",
        },
        10,
        {
          argv: ["context", "target", "--json"],
          expectNonEmpty: true,
          expectation: { kind: "context", callers: 28, callees: 1, history: 1 },
        },
      ),
      BenchmarkSampleEvidence.from(
        "stats",
        0,
        { status: 0, stdout: '{"totalEvents":0}', stderr: "" },
        { status: 0, stdout: '{"totalEvents":0}', stderr: "" },
        10,
        {
          argv: ["stats", "--json"],
          expectNonEmpty: true,
          expectation: { kind: "stats-shape" },
        },
      ),
    ];

    expect(BenchmarkSampleEvidence.semanticResultsValid(invalid)).toBe(false);
  });

  it("publishes nearest-rank statistics for every attributed command phase", () => {
    const samples = Array.from({ length: 9 }, (_, repetition) => ({
      ...BenchmarkSampleEvidence.from(
        "overview",
        repetition,
        { status: 0, stdout: "ok", stderr: "" },
        { status: 0, stdout: "ok", stderr: "" },
        10,
        { argv: ["overview", "target.ts"], expectNonEmpty: true },
      ),
      freshnessMs: repetition + 1,
      navigationMs: repetition + 1,
      renderMs: repetition + 1,
      workerOutputMs: repetition + 1,
      spoolMs: repetition + 1,
    }));

    expect(DaemonBenchmarkPhaseStatistics.from(samples).overview).toEqual({
      freshness: { minimumMs: 1, p50Ms: 5, p95Ms: 9, maximumMs: 9 },
      navigation: { minimumMs: 1, p50Ms: 5, p95Ms: 9, maximumMs: 9 },
      render: { minimumMs: 1, p50Ms: 5, p95Ms: 9, maximumMs: 9 },
      workerOutput: { minimumMs: 1, p50Ms: 5, p95Ms: 9, maximumMs: 9 },
      spool: { minimumMs: 1, p50Ms: 5, p95Ms: 9, maximumMs: 9 },
    });
  });
});

class TestDiagnostics {
  static withMissingOverviewAndLaterResolve(): string {
    const directory = mkdtempSync(join(tmpdir(), "symnav-benchmark-diagnostics-"));
    const logPath = join(directory, "daemon.jsonl");
    const events = Array.from({ length: 9 }, (_, index) => {
      const requestId = `request-${index}`;
      const command = index === 8 ? "resolve" : "overview";
      return [
        { kind: "request-accepted", requestId, command },
        { kind: "turn-started", requestId, queueWaitMs: 1 },
        {
          kind: "worker-completed",
          requestId,
          freshnessMs: 1,
          navigationMs: 1,
          renderMs: 1,
          workerOutputMs: 1,
        },
        { kind: "response-spooled", requestId, rawBytes: 1, spoolMs: 1 },
        {
          kind: "execution-terminal",
          requestId,
          outcome: "completed",
          serviceMs: 2,
          peakProcessRssBytes: 3,
        },
        { kind: "delivery-terminal", requestId, outcome: "delivered", deliveryMs: 1 },
      ];
    }).flat();
    writeFileSync(logPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    return logPath;
  }

  static withDuplicatedAndMissingOverviewTerminal(): string {
    const directory = mkdtempSync(join(tmpdir(), "symnav-benchmark-diagnostics-"));
    const logPath = join(directory, "daemon.jsonl");
    const events = Array.from({ length: 9 }, (_, index) => {
      const requestId = `request-${index}`;
      const executionTerminals = index === 0 ? 2 : index === 1 ? 0 : 1;
      return [
        { kind: "request-accepted", requestId, command: "overview" },
        { kind: "turn-started", requestId, queueWaitMs: 1 },
        {
          kind: "worker-completed",
          requestId,
          freshnessMs: 1,
          navigationMs: 1,
          renderMs: 1,
          workerOutputMs: 1,
        },
        { kind: "response-spooled", requestId, rawBytes: 1, spoolMs: 1 },
        ...Array.from({ length: executionTerminals }, () => ({
          kind: "execution-terminal",
          requestId,
          outcome: "completed",
          serviceMs: 2,
          peakProcessRssBytes: 3,
        })),
        { kind: "delivery-terminal", requestId, outcome: "delivered", deliveryMs: 1 },
      ];
    }).flat();
    writeFileSync(logPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    return logPath;
  }
}
