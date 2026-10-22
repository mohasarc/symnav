import { describe, expect, it, vi } from "vitest";
import type { DaemonSequencedOutputRecord } from "../daemon-executor.js";
import { AcceptedRequestLedger } from "./accepted-request-ledger.js";
import type {
  AcceptedExecutionDelivery,
  AcceptedExecutionLifetime,
  AcceptedExecutionProcessLifecycle,
  AuthenticatedDaemonExecuteRequest,
} from "./accepted-execution-session-contracts.js";
import { AcceptedExecutionSession } from "./accepted-execution-session.js";
import type { DaemonCompletionWriter } from "../delivery/delivery-session.js";
import type {
  DaemonDiagnosticEvent,
  DaemonOperationTrace,
} from "../diagnostics/operation-observer.js";
import type { DaemonResourceSupervisor } from "../resources/resource-supervisor.js";
import type { DaemonWorkerGenerationManager } from "../worker/worker-generation-manager.js";
import { WorkspaceRequestQueue } from "./request-queue.js";

describe("AcceptedExecutionSession", () => {
  it("observes navigation activity separately from immutable acceptance metadata", () => {
    let wallNow = 1_234;
    const wallNowMs = vi.fn(() => wallNow++);
    const harness = new AcceptedExecutionHarness({ wallNowMs });

    const accepted = harness.session.accept(harness.request("request"));
    const duplicate = harness.session.accept(harness.request("request"));

    expect(accepted.acceptance.acceptedAt).toBe(1_234);
    expect(harness.session.snapshot.lastNavigationAt).toBe(1_235);
    expect(duplicate).toMatchObject({
      newlyAccepted: false,
      entry: accepted.entry,
      acceptance: accepted.acceptance,
    });
    expect(wallNowMs).toHaveBeenCalledTimes(2);
    expect(harness.navigationAccepted).toHaveBeenCalledTimes(1);
  });

  it("records immutable acceptance and synchronously schedules one turn", async () => {
    const harness = new AcceptedExecutionHarness();

    const accepted = harness.session.accept(harness.request("request"));
    const duplicate = harness.session.accept(harness.request("request"));

    expect(accepted).toMatchObject({
      newlyAccepted: true,
      acceptance: { requestId: "request", acceptedAt: 100, queuePosition: 0 },
    });
    expect(duplicate).toMatchObject({
      newlyAccepted: false,
      entry: accepted.entry,
      acceptance: accepted.acceptance,
    });
    expect(harness.events.slice(0, 4)).toEqual([
      "navigation-accepted",
      "trace-accepted:0:7",
      "turn-started:7",
      "completion-created",
    ]);
    expect(harness.navigationAccepted).toHaveBeenCalledTimes(1);

    await harness.session.drain();
    expect(harness.workerExecute).toHaveBeenCalledTimes(1);
    expect(harness.session.status("request")).toEqual({ state: "completed" });
    expect(harness.session.snapshot.lastNavigationAt).toBe(100);
  });

  it("preserves spool, ledger, delivery, workspace, and resource turn barriers", async () => {
    const harness = new AcceptedExecutionHarness({ workspaceExists: false });

    harness.session.accept(harness.request("deleted"));
    harness.observeTerminal("deleted");
    await harness.session.drain();

    expect(harness.events).toEqual([
      "navigation-accepted",
      "trace-accepted:0:7",
      "turn-started:7",
      "completion-created",
      "output-appended:0",
      "worker-observed-append",
      "worker-heap-reported:7:11:20:13",
      "worker-completed",
      "completion-finished:0",
      "workspace-checked",
      "execution-completed",
      "ledger-completed",
      "delivery-tracked",
      "workspace-deleted-after-delivery",
      "resource-sampled",
      "queue-idle",
    ]);
    expect(harness.session.snapshot.lastCompletedMonotonicAt).toBeDefined();
  });

  it("consumes one active resource interruption when classifying failure", async () => {
    const harness = new AcceptedExecutionHarness({ workerFailure: new Error("worker failed") });

    harness.session.accept(harness.request("failed"));
    harness.session.accept(harness.request("following"));
    await Promise.resolve();
    harness.session.markActiveResourceInterrupted("hard-pressure");
    await harness.session.drain();

    expect(harness.session.status("failed")).toEqual({
      state: "failed",
      code: "controlled-resource",
    });
    expect(harness.session.status("following")).toEqual({ state: "failed", code: "internal" });
    expect(harness.diagnostics).toEqual([
      expect.objectContaining({
        kind: "failure",
        operation: "request",
        failureCode: "internal",
        errorName: "Error",
      }),
      expect.objectContaining({
        kind: "failure",
        operation: "request",
        failureCode: "internal",
        errorName: "Error",
      }),
    ]);
  });

  it("records cleanup and turn-boundary sampling failures through the diagnostic port", async () => {
    const failed = new AcceptedExecutionHarness({
      workerFailure: new Error("worker failed"),
      completionDisposeFailure: new TypeError("dispose failed"),
    });
    failed.session.accept(failed.request("failed"));
    await failed.session.drain();

    expect(failed.diagnostics).toEqual([
      expect.objectContaining({
        operation: "request",
        failureCode: "internal",
        errorName: "Error",
      }),
      expect.objectContaining({
        operation: "completion-cleanup",
        failureCode: "internal",
        errorName: "TypeError",
      }),
    ]);

    const sampled = new AcceptedExecutionHarness({
      resourceSampleFailure: new RangeError("sample failed"),
    });
    sampled.session.accept(sampled.request("sampled"));
    await sampled.session.drain();

    expect(sampled.diagnostics).toEqual([
      expect.objectContaining({
        operation: "resource-sample",
        failureCode: "operation-failed",
        errorName: "RangeError",
      }),
    ]);
    expect(sampled.events.at(-1)).toBe("queue-idle");
  });
});

interface AcceptedExecutionHarnessOptions {
  readonly workspaceExists?: boolean;
  readonly workerFailure?: Error;
  readonly completionDisposeFailure?: Error;
  readonly resourceSampleFailure?: Error;
  readonly wallNowMs?: () => number;
}

class AcceptedExecutionHarness {
  readonly events: string[] = [];
  readonly diagnostics: DaemonDiagnosticEvent[] = [];
  readonly navigationAccepted = vi.fn(() => this.events.push("navigation-accepted"));
  readonly workerExecute = vi.fn(
    async (
      _requestId: string,
      _request: unknown,
      output: { append(record: DaemonSequencedOutputRecord): Promise<void> },
    ) => {
      await output.append({ sequence: 0, stream: "stdout", bytes: new Uint8Array([1]) });
      this.events.push("worker-observed-append");
      if (this.options.workerFailure !== undefined) throw this.options.workerFailure;
      return {
        kind: "result" as const,
        generation: 7,
        requestId: _requestId,
        result: { exitCode: 0 },
        refresh: { added: 0, changed: 0, removed: 0, unchanged: 1 },
        durations: { freshnessMs: 1, navigationMs: 2, renderMs: 3, outputMs: 4 },
        resources: {
          workerHeapUsedBytes: 11,
          peakWorkerHeapUsedBytes: 13,
          workerHeapLimitBytes: 20,
        },
      };
    },
  );
  readonly session: AcceptedExecutionSession;
  private readonly ledger: AcceptedRequestLedger;
  private wallNow = 100;
  private monotonicNow = 1_000;

  constructor(private readonly options: AcceptedExecutionHarnessOptions = {}) {
    const ledger = new AcceptedRequestLedger({ wallNowMs: () => this.wallNowMs() });
    this.ledger = ledger;
    const queue = new WorkspaceRequestQueue({ monotonicNowMs: () => this.monotonicNow++ });
    const completion: DaemonCompletionWriter = {
      append: async (record) => {
        this.events.push(`output-appended:${record.sequence}`);
      },
      finish: async (exitCode) => {
        this.events.push(`completion-finished:${exitCode}`);
        return {
          transferId: "transfer",
          requestId: "request",
          instanceId: "instance",
          exitCode,
          rawBytes: 1,
          recordCount: 1,
          sha256: "hash",
        };
      },
      dispose: async () => {
        this.events.push("completion-disposed");
        if (this.options.completionDisposeFailure !== undefined) {
          throw this.options.completionDisposeFailure;
        }
      },
    };
    const trace: DaemonOperationTrace = {
      accepted: (queuePosition, generation) =>
        this.events.push(`trace-accepted:${queuePosition}:${generation}`),
      turnStarted: (generation) => this.events.push(`turn-started:${generation}`),
      workerCompleted: () => this.events.push("worker-completed"),
      spooled: () => undefined,
      executionTerminated: (outcome) => this.events.push(`execution-${outcome}`),
      clientDisconnected: () => undefined,
      reattached: () => undefined,
      deliveryTerminated: () => undefined,
    };
    const delivery: AcceptedExecutionDelivery = {
      beginAcceptedTrace: (_requestId, _command, queuePosition, generation) => {
        trace.accepted(queuePosition, generation);
        return trace;
      },
      createCompletion: async () => {
        this.events.push("completion-created");
        return completion;
      },
      trackedCompletion: () => {
        this.events.push("delivery-tracked");
        return Promise.resolve();
      },
    };
    const worker = {
      snapshot: { generation: 7, ready: true, fileCount: 1 },
      execute: this.workerExecute,
    } as unknown as DaemonWorkerGenerationManager;
    const resourceSupervisor = {
      snapshot: { generation: 7 },
      workerHeapReported: (generation: number, used: number, limit: number, peak: number) => {
        this.events.push(`worker-heap-reported:${generation}:${used}:${limit}:${peak}`);
      },
      sampleAtTurnBoundary: async () => {
        this.events.push("resource-sampled");
        if (this.options.resourceSampleFailure !== undefined) {
          throw this.options.resourceSampleFailure;
        }
      },
    } as unknown as DaemonResourceSupervisor;
    const processLifecycle: AcceptedExecutionProcessLifecycle = {
      shutdownSnapshot: () => ({ started: false }),
      workspaceExists: async () => {
        this.events.push("workspace-checked");
        return this.options.workspaceExists ?? true;
      },
      workspaceDeletedAfterDelivery: async () => {
        this.events.push("workspace-deleted-after-delivery");
      },
    };
    const lifetime: AcceptedExecutionLifetime = {
      navigationAccepted: this.navigationAccepted,
      queueBecameIdle: () => this.events.push("queue-idle"),
    };
    this.session = new AcceptedExecutionSession({
      ledger,
      queue,
      worker,
      delivery,
      resourceSupervisor,
      processLifecycle,
      lifetime,
      diagnostics: { record: (event) => this.diagnostics.push(event) },
      clock: {
        wallNowMs: () => this.wallNowMs(),
        monotonicNowMs: () => this.monotonicNow++,
      },
    });
  }

  private wallNowMs(): number {
    return this.options.wallNowMs?.() ?? this.wallNow;
  }

  request(requestId: string): AuthenticatedDaemonExecuteRequest {
    return {
      kind: "execute",
      protocolVersion: 5,
      instanceId: "instance",
      processToken: "token",
      requestId,
      commandName: "version",
      request: {
        argv: ["--version"],
        cwd: "/repo",
        telemetryEnabled: false,
        executionMode: "warm",
      },
    };
  }

  observeTerminal(requestId: string): void {
    this.ledger.subscribe(requestId, (entry) => {
      if (entry.state.state === "completed") this.events.push("ledger-completed");
    });
  }
}
