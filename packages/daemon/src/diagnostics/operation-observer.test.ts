import { describe, expect, it } from "vitest";
import type { DaemonClock } from "../lifecycle/daemon-clock.js";
import { DaemonOperationObserver, type DaemonDiagnosticEvent } from "./operation-observer.js";

describe("DaemonOperationObserver", () => {
  it("separates queue, service, spool, execution, and delivery observations", () => {
    const clock = new MutableDaemonClock(1_000, 10);
    const events: DaemonDiagnosticEvent[] = [];
    const observer = new DaemonOperationObserver({ record: (event) => events.push(event) }, clock);
    const trace = observer.start("request-one", "refs");

    trace.accepted(2, 3);
    clock.monotonic = 30;
    trace.turnStarted(3);
    clock.wall = -20_000;
    clock.monotonic = 70;
    trace.workerCompleted(
      { freshnessMs: 2, navigationMs: 31, renderMs: 4, workerOutputMs: 3 },
      { added: 1, changed: 2, removed: 3, unchanged: 4 },
    );
    clock.monotonic = 80;
    trace.spooled(
      {
        transferId: "transfer-one",
        requestId: "request-one",
        instanceId: "instance-one",
        exitCode: 0,
        rawBytes: 128,
        recordCount: 2,
        sha256: "hash",
      },
      7,
    );
    clock.monotonic = 90;
    trace.executionTerminated("completed");
    clock.monotonic = 95;
    trace.clientDisconnected();
    clock.monotonic = 100;
    trace.reattached();
    clock.monotonic = 120;
    trace.deliveryTerminated("delivered");

    expect(events).toEqual([
      {
        kind: "request-accepted",
        requestId: "request-one",
        command: "refs",
        queueDepth: 2,
        workerGeneration: 3,
      },
      { kind: "turn-started", requestId: "request-one", queueWaitMs: 20, workerGeneration: 3 },
      {
        kind: "worker-completed",
        requestId: "request-one",
        freshnessMs: 2,
        navigationMs: 31,
        renderMs: 4,
        workerOutputMs: 3,
        added: 1,
        changed: 2,
        removed: 3,
        unchanged: 4,
      },
      {
        kind: "response-spooled",
        requestId: "request-one",
        rawBytes: 128,
        recordCount: 2,
        spoolMs: 7,
      },
      { kind: "execution-terminal", requestId: "request-one", outcome: "completed", serviceMs: 60 },
      { kind: "client-disconnected", requestId: "request-one" },
      { kind: "client-reattached", requestId: "request-one" },
      { kind: "delivery-terminal", requestId: "request-one", outcome: "delivered", deliveryMs: 30 },
    ]);
  });

  it("records at most one execution terminal and one delivery terminal", () => {
    const events: DaemonDiagnosticEvent[] = [];
    const observer = new DaemonOperationObserver(
      { record: (event) => events.push(event) },
      new MutableDaemonClock(1, 1),
    );
    const trace = observer.start("request-two", "overview");

    trace.executionTerminated("failed");
    trace.executionTerminated("completed");
    trace.deliveryTerminated("disconnected");
    trace.deliveryTerminated("failed");

    expect(events.filter((event) => event.kind === "execution-terminal")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "delivery-terminal")).toHaveLength(1);
  });

  it("preserves an earlier process RSS peak at execution completion", () => {
    const events: DaemonDiagnosticEvent[] = [];
    const observer = new DaemonOperationObserver(
      { record: (event) => events.push(event) },
      new MutableDaemonClock(1, 1),
      {
        snapshot: {
          processRssBytes: 80,
          peakProcessRssBytes: 120,
          peakWorkerHeapUsedBytes: 400,
          spoolBytes: 0,
        },
      },
    );
    const trace = observer.start("request-peak", "context");

    trace.turnStarted(1);
    trace.executionTerminated("completed");

    expect(events).toContainEqual({
      kind: "execution-terminal",
      requestId: "request-peak",
      outcome: "completed",
      serviceMs: 0,
      processRssBytes: 80,
      peakProcessRssBytes: 120,
      peakWorkerHeapUsedBytes: 400,
      spoolBytes: 0,
    });
  });

  it("records closed startup, worker recovery, and shutdown diagnostics", () => {
    const events: DaemonDiagnosticEvent[] = [];
    const observer = new DaemonOperationObserver(
      { record: (event) => events.push(event) },
      new MutableDaemonClock(1, 1),
    );

    observer.startup({
      kind: "startup-completed",
      workerGeneration: 1,
      fileCount: 14,
      discoveryMs: 3,
      indexingMs: 20,
      totalMs: 23,
    });
    observer.worker({
      kind: "resources-released",
      workerGeneration: 1,
      workerHeapUsedBytes: 256,
      workerHeapLimitBytes: 1_024,
    });
    observer.worker({
      kind: "worker-replaced",
      cause: "shed-failure",
      previousWorkerGeneration: 1,
      workerGeneration: 2,
      fileCount: 14,
      discoveryMs: 2,
      indexingMs: 18,
      totalMs: 20,
    });
    observer.shutdown({ kind: "shutdown", reason: "resource", force: true });

    expect(events).toEqual([
      {
        kind: "startup-completed",
        workerGeneration: 1,
        fileCount: 14,
        discoveryMs: 3,
        indexingMs: 20,
        totalMs: 23,
      },
      {
        kind: "resources-released",
        workerGeneration: 1,
        workerHeapUsedBytes: 256,
        workerHeapLimitBytes: 1_024,
      },
      {
        kind: "worker-replaced",
        cause: "shed-failure",
        previousWorkerGeneration: 1,
        workerGeneration: 2,
        fileCount: 14,
        discoveryMs: 2,
        indexingMs: 18,
        totalMs: 20,
      },
      { kind: "shutdown", reason: "resource", force: true },
    ]);
  });
});

class MutableDaemonClock implements DaemonClock {
  constructor(
    public wall: number,
    public monotonic: number,
  ) {}

  wallNowMs(): number {
    return this.wall;
  }

  monotonicNowMs(): number {
    return this.monotonic;
  }
}
