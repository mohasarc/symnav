import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { AcceptedRequestLedger } from "./accepted-request-ledger.js";
import { CompletionSpoolReadError, DaemonCompletionSpoolStore } from "./completion-spool.js";
import { DaemonDeliverySession } from "./daemon-delivery-session.js";
import { DaemonOperationObserver } from "./daemon-operation-observer.js";
import type { DaemonDiagnosticEvent, DaemonServerMessage } from "./daemon-protocol.js";
import type { DaemonServerSend } from "./daemon-transport.js";

describe("DaemonDeliverySession", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("creates completion writers and records their spool timing", async () => {
    const harness = await DeliverySessionHarness.create(directories);
    const trace = harness.session.beginAcceptedTrace("request-1", "version", 2, 3);

    const completion = await harness.session.createCompletion("request-1");
    await completion.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("result\n") });
    harness.setMonotonicTimes(11, 17);
    const manifest = await completion.finish(4);

    expect(trace).toBeDefined();
    expect(manifest).toMatchObject({
      requestId: "request-1",
      instanceId: "instance-1",
      exitCode: 4,
      rawBytes: 7,
      recordCount: 1,
    });
    expect(harness.session.snapshot).toEqual({
      spoolBytes: 7,
      hasUnacknowledgedCompletions: false,
    });
    expect(harness.events).toEqual([
      {
        kind: "request-accepted",
        requestId: "request-1",
        command: "version",
        queueDepth: 2,
        workerGeneration: 3,
      },
      {
        kind: "response-spooled",
        requestId: "request-1",
        rawBytes: 7,
        recordCount: 1,
        spoolMs: 6,
      },
    ]);
  });

  it("streams one completion to each attachment and counts connection closes", async () => {
    const harness = await DeliverySessionHarness.create(directories);
    const entry = harness.journal.accept("request-1", "version", harness.executionRequest);
    if (entry.state.state !== "queued") throw new Error("Expected queued request");
    harness.session.beginAcceptedTrace("request-1", "version", entry.state.queuePosition, 1);
    const first = DeliverySend.create();
    const duplicate = DeliverySend.create();

    await harness.session.attach(
      {
        requestId: "request-1",
        acceptedAt: entry.state.acceptedAt,
        queuePosition: entry.state.queuePosition,
      },
      first.send,
    );
    await harness.session.attach(
      {
        requestId: "request-1",
        acceptedAt: entry.state.acceptedAt,
        queuePosition: entry.state.queuePosition,
      },
      duplicate.send,
    );
    const completion = await harness.session.createCompletion("request-1");
    await completion.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("result\n") });
    await completion.finish(0);
    harness.journal.markRunning("request-1", 2);
    harness.journal.complete("request-1", "request-1", 3);
    await Promise.all([first.resultEndReceived, duplicate.resultEndReceived]);

    expect(first.frames.map(DeliverySend.frameKind)).toEqual([
      "accepted",
      "result-manifest",
      "chunk",
      "result-end",
    ]);
    expect(duplicate.frames.map(DeliverySend.frameKind)).toEqual([
      "accepted",
      "result-manifest",
      "chunk",
      "result-end",
    ]);
    first.close();
    expect(harness.events.filter((event) => event.kind === "client-disconnected")).toHaveLength(0);
    duplicate.close();
    duplicate.close();
    expect(harness.events.filter((event) => event.kind === "client-disconnected")).toHaveLength(1);
    expect(harness.events.filter((event) => event.kind === "client-reattached")).toHaveLength(0);
    expect(harness.events.filter((event) => event.kind === "delivery-terminal")).toHaveLength(1);
  });

  it("keeps the latest duplicate completion delivery as the request barrier", async () => {
    const harness = await DeliverySessionHarness.create(directories);
    const entry = harness.journal.accept("request-1", "version", harness.executionRequest);
    if (entry.state.state !== "queued") throw new Error("Expected queued request");
    harness.session.beginAcceptedTrace("request-1", "version", entry.state.queuePosition, 1);
    const firstResultEnd = new DeferredSignal();
    const secondResultEnd = new DeferredSignal();
    const first = DeliverySend.create((message) =>
      "kind" in message && message.kind === "result-end" ? firstResultEnd.wait : undefined,
    );
    const duplicate = DeliverySend.create((message) =>
      "kind" in message && message.kind === "result-end" ? secondResultEnd.wait : undefined,
    );
    await harness.session.attach(
      {
        requestId: "request-1",
        acceptedAt: entry.state.acceptedAt,
        queuePosition: entry.state.queuePosition,
      },
      first.send,
    );
    await harness.session.attach(
      {
        requestId: "request-1",
        acceptedAt: entry.state.acceptedAt,
        queuePosition: entry.state.queuePosition,
      },
      duplicate.send,
    );
    const completion = await harness.session.createCompletion("request-1");
    await completion.finish(0);
    harness.journal.markRunning("request-1", 2);
    harness.journal.complete("request-1", "request-1", 3);
    const latestDelivery = harness.session.trackedCompletion("request-1");
    if (latestDelivery === undefined) throw new Error("Expected tracked completion delivery");
    let settled = false;
    void latestDelivery.then(() => {
      settled = true;
    });

    firstResultEnd.release();
    await first.resultEndReceived;
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    expect(harness.session.trackedCompletion("request-1")).toBe(latestDelivery);
    expect(duplicate.frames.some((frame) => DeliverySend.frameKind(frame) === "result-end")).toBe(
      false,
    );

    secondResultEnd.release();
    await latestDelivery;

    expect(settled).toBe(true);
    expect(harness.session.trackedCompletion("request-1")).toBeUndefined();
  });

  it("fetches retained completion output from the requested offset", async () => {
    const harness = await DeliverySessionHarness.create(directories);
    harness.accept("request-1");
    const completion = await harness.session.createCompletion("request-1");
    await completion.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("first") });
    await completion.append({ sequence: 1, stream: "stderr", bytes: Buffer.from("second") });
    const manifest = await completion.finish(0);
    harness.complete("request-1");
    const fetched = DeliverySend.create();

    await harness.session.fetch(
      {
        kind: "result-fetch",
        protocolVersion: 5,
        instanceId: "instance-1",
        processToken: "token-1",
        requestId: "request-1",
        offset: 1,
      },
      fetched.send,
    );

    expect(fetched.frames.map(DeliverySend.frameKind)).toEqual([
      "result-manifest",
      "chunk",
      "result-end",
    ]);
    expect(fetched.frames[1]).toMatchObject({ sequence: 1, offset: 1, stream: "stderr" });
    expect(harness.journal.status("request-1")).toEqual({ state: "completed" });
    expect(harness.session.snapshot.spoolBytes).toBe(11);
    expect(manifest.transferId).toEqual(expect.any(String));
  });

  it("invalidates completed journal state before reporting a spool read failure", async () => {
    const harness = await DeliverySessionHarness.create(directories);
    harness.accept("request-1");
    const completion = await harness.session.createCompletion("request-1");
    await completion.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("result") });
    await completion.finish(0);
    harness.complete("request-1");
    const spool = await harness.spoolStore.open("request-1");
    if (spool === undefined) throw new Error("Expected completion spool");
    vi.spyOn(spool, "read").mockImplementation(async function* () {
      throw new CompletionSpoolReadError(new Error("read failed"));
    });
    let stateWhenFailureWasSent: unknown;
    const fetched = DeliverySend.create((message) => {
      if ("kind" in message && message.kind === "execution-failed") {
        stateWhenFailureWasSent = harness.journal.status("request-1");
      }
    });

    await harness.session.fetch(
      {
        kind: "result-fetch",
        protocolVersion: 5,
        instanceId: "instance-1",
        processToken: "token-1",
        requestId: "request-1",
        offset: 0,
      },
      fetched.send,
    );

    expect(stateWhenFailureWasSent).toEqual({ state: "failed", code: "internal" });
    expect(fetched.frames.map(DeliverySend.frameKind)).toEqual([
      "result-manifest",
      "execution-failed",
    ]);
    expect(
      harness.events.filter(
        (event) => event.kind === "failure" && event.operation === "completion-delivery",
      ),
    ).toHaveLength(1);
    expect(harness.session.snapshot.spoolBytes).toBe(0);
  });
});

class DeliverySessionHarness {
  private constructor(
    readonly session: DaemonDeliverySession,
    readonly journal: AcceptedRequestLedger,
    readonly spoolStore: DaemonCompletionSpoolStore,
    readonly events: DaemonDiagnosticEvent[],
    private readonly time: { monotonicNow: number; remaining: number[] },
  ) {}

  static async create(directories: string[]): Promise<DeliverySessionHarness> {
    const directory = await mkdtemp(join(tmpdir(), "symnav-delivery-session-"));
    directories.push(directory);
    const policy = DaemonPolicy.currentSystem().values;
    const journal = new AcceptedRequestLedger(() => 1);
    const events: DaemonDiagnosticEvent[] = [];
    const time = { monotonicNow: 0, remaining: [] as number[] };
    const clock = {
      wallNowMs: () => 1,
      monotonicNowMs: () => {
        time.monotonicNow = time.remaining.shift() ?? time.monotonicNow;
        return time.monotonicNow;
      },
    };
    const diagnostics = { record: (event: DaemonDiagnosticEvent) => events.push(event) };
    const observer = new DaemonOperationObserver(diagnostics, clock);
    const spoolStore = new DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace-1",
      instanceId: "instance-1",
      policy: policy.output,
    });
    const harness = new DeliverySessionHarness(
      new DaemonDeliverySession({
        coordinates: { instanceId: "instance-1", processToken: "token-1" },
        journal,
        spoolStore,
        observer,
        diagnostics,
        clock,
        policy,
      }),
      journal,
      spoolStore,
      events,
      time,
    );
    return harness;
  }

  setMonotonicTimes(...monotonicTimes: number[]): void {
    this.time.remaining.push(...monotonicTimes);
  }

  accept(requestId: string): void {
    this.journal.accept(requestId, "version", this.executionRequest);
  }

  complete(requestId: string): void {
    this.journal.markRunning(requestId, 2);
    this.journal.complete(requestId, requestId, 3);
  }

  get executionRequest() {
    return {
      argv: ["--version"],
      cwd: "/workspace",
      telemetryEnabled: false,
      executionMode: "warm" as const,
    };
  }
}

class DeliverySend {
  readonly frames: DaemonServerMessage[] = [];
  readonly resultEndReceived: Promise<void>;
  private readonly closeListeners = new Set<() => void>();
  private resolveResultEndReceived!: () => void;
  readonly send: DaemonServerSend;

  private constructor(onMessage?: (message: DaemonServerMessage) => void | Promise<void>) {
    this.resultEndReceived = new Promise((resolve) => {
      this.resolveResultEndReceived = resolve;
    });
    this.send = Object.assign(
      async (message: DaemonServerMessage) => {
        await onMessage?.(message);
        this.frames.push(message);
        if ("kind" in message && message.kind === "result-end") {
          this.resolveResultEndReceived();
        }
      },
      {
        onClose: (listener: () => void) => {
          this.closeListeners.add(listener);
          return () => this.closeListeners.delete(listener);
        },
      },
    );
  }

  static create(onMessage?: (message: DaemonServerMessage) => void | Promise<void>): DeliverySend {
    return new DeliverySend(onMessage);
  }

  close(): void {
    for (const listener of this.closeListeners) listener();
  }

  static frameKind(frame: DaemonServerMessage): string {
    return "kind" in frame ? frame.kind : "chunk";
  }
}

class DeferredSignal {
  readonly wait: Promise<void>;
  private resolveWait!: () => void;

  constructor() {
    this.wait = new Promise((resolve) => {
      this.resolveWait = resolve;
    });
  }

  release(): void {
    this.resolveWait();
  }
}
