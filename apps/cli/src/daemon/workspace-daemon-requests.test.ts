import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandOutputSnapshot,
  type CliExecutionRequest,
  type CommandExecutionResult,
  type CommandOutputRecord,
} from "../command-execution-result.js";
import { createDefaultDependencies } from "../program.js";
import type {
  DaemonExecutionServerFrame,
  DaemonExecutionStatusResponse,
  DaemonRequest,
  DaemonResponse,
  DaemonServerMessage,
  DaemonServer,
} from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_RECORD_SCHEMA_VERSION } from "./daemon-protocol.js";
import { NodeCompletionSpoolStorage, type CompletionSpoolFile } from "./completion-spool.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";
import type {
  DaemonNavigationWorker,
  DaemonNavigationWorkerExit,
} from "./daemon-navigation-worker.js";
import { NodeDaemonNavigationWorker } from "./daemon-navigation-worker.js";
import type { DaemonNavigationWorkerResponse } from "./daemon-navigation-worker-protocol.js";
import { DaemonResourcePolicy } from "./daemon-resource-monitor.js";
import { WorkspaceDaemon, type WorkspaceDaemonOptions } from "./workspace-daemon.js";

describe("WorkspaceDaemon requests", () => {
  const harnesses: RequestHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.map((harness) => harness.dispose()));
    harnesses.length = 0;
  });

  it("authorizes startup before listening and publishes readiness", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    expect(harness.transport.isListening).toBe(true);
    expect(harness.registry.read(harness.identity)).toMatchObject({
      state: "ready",
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      fileCount: 1,
    });
  });

  it("binds lifecycle transport while navigation initialization is blocked", async () => {
    const worker = new DeferredInitializationWorker();
    const { daemon, harness, lease } = RequestHarness.create(undefined, {
      navigationWorker: worker,
    });
    harnesses.push(harness);

    const starting = daemon.start();
    await worker.initializationStarted;

    expect(harness.transport.isListening).toBe(true);
    const startingStatus = await harness.ping();
    expect(startingStatus).toMatchObject({
      kind: "pong",
      state: "starting",
      activity: {
        lifecycle: "starting",
        pid: process.pid,
        startupElapsedMs: expect.any(Number),
        queued: 0,
        workerGeneration: 1,
        spoolBytes: 0,
      },
    });
    if (startingStatus.kind !== "pong" || startingStatus.activity === undefined) {
      throw new Error("Expected daemon activity snapshot");
    }
    expect(() => Object.assign(startingStatus.activity, { queued: 9 })).toThrow();
    expect(harness.registry.read(harness.identity)?.state).toBe("starting");

    worker.completeInitialization();
    await starting;
    lease.release();
    expect(harness.registry.read(harness.identity)?.state).toBe("ready");
  });

  it("claims and heartbeats daemon ownership throughout blocked initialization", async () => {
    const worker = new DeferredInitializationWorker();
    const { daemon, harness } = RequestHarness.create(undefined, {
      navigationWorker: worker,
      startupHeartbeatIntervalMs: 5,
    });
    harnesses.push(harness);

    const starting = daemon.start();
    await worker.initializationStarted;
    const claimedOwner = harness.registry.startupOwner(harness.identity);
    expect(claimedOwner).toMatchObject({
      ownerKind: "daemon",
      ownerPid: process.pid,
      processToken: harness.processToken,
    });

    await waitUntil(
      () => harness.registry.startupOwner(harness.identity)?.revision !== claimedOwner?.revision,
    );

    worker.completeInitialization();
    await starting;
    expect(harness.registry.read(harness.identity)?.state).toBe("ready");
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
  });

  it("claims startup from an exact live launcher despite an old heartbeat", async () => {
    const { daemon, harness } = RequestHarness.create(new ImmediateExecutor());
    harnesses.push(harness);
    const owner = harness.registry.startupOwner(harness.identity);
    if (owner === undefined) throw new Error("Expected startup owner");
    writeFileSync(
      harness.identity.startupOwnerPath(harness.identity.lockPath),
      JSON.stringify({ ...owner, acquiredAt: 1, heartbeatAt: 1 }),
    );

    await expect(daemon.start()).resolves.toBeUndefined();
    expect(harness.registry.read(harness.identity)?.state).toBe("ready");
  });

  it("waits through the registry mutation grace for startup authorization", async () => {
    let claimAttempts = 0;
    const { daemon, harness } = RequestHarness.create(new ImmediateExecutor(), {
      now: () => claimAttempts * 1_000,
    });
    harnesses.push(harness);
    const claimStartupForDaemon = harness.registry.claimStartupForDaemon.bind(harness.registry);
    vi.spyOn(harness.registry, "claimStartupForDaemon").mockImplementation((...arguments_) => {
      claimAttempts += 1;
      if (claimAttempts <= 6) return undefined;
      return claimStartupForDaemon(...arguments_);
    });

    await expect(daemon.start()).resolves.toBeUndefined();

    expect(claimAttempts).toBe(7);
    expect(harness.registry.read(harness.identity)?.state).toBe("ready");
  });

  it("cleans exact starting ownership when worker initialization fails", async () => {
    const worker = new RejectingInitializationWorker();
    const { daemon, harness } = RequestHarness.create(undefined, { navigationWorker: worker });
    harnesses.push(harness);

    await expect(daemon.start()).rejects.toThrow("initialization failed");

    expect(worker.terminateCount).toBe(1);
    expect(harness.transport.isListening).toBe(false);
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
    expect(
      harness.registry.readStoredInstance(harness.identity, harness.instanceId),
    ).toBeUndefined();
  });

  it("authenticates identity requests", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await expect(
      harness.transport.receive({
        kind: "identify",
        instanceId: harness.instanceId,
        processToken: "wrong-token",
      }),
    ).rejects.toThrow("identity request");
    await expect(harness.identify()).resolves.toMatchObject({
      kind: "identity",
      instanceId: harness.instanceId,
      processToken: harness.processToken,
    });
  });

  it("authenticates termination requests", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await expect(
      harness.transport.receive({
        kind: "terminate",
        instanceId: harness.instanceId,
        processToken: "wrong-token",
      }),
    ).rejects.toThrow("termination");
    await expect(harness.terminate()).resolves.toEqual({
      kind: "terminating",
      instanceId: harness.instanceId,
      processToken: harness.processToken,
    });
  });

  it("reports protocol and process identity to matching pings", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await expect(harness.ping()).resolves.toMatchObject({
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: harness.instanceId,
      symnavVersion: "test",
    });
  });

  it("reports workspace status metrics in daemon pings", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await expect(harness.ping()).resolves.toMatchObject({
      startedAt: expect.any(Number),
      fileCount: 1,
      memoryBytes: expect.any(Number),
    });
  });

  it("executes matching workspace requests", async () => {
    const executor = new RecordingExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);

    await expect(harness.execute("one")).resolves.toMatchObject({
      kind: "result-end",
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      requestId: "one",
      rawBytes: 0,
      recordCount: 0,
      sha256: expect.stringMatching(/^[a-f\d]{64}$/),
    });
    expect(executor.requests).toHaveLength(1);
  });

  it("timestamps daemon requests when they are accepted", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor(), { now: () => 1_234 });
    harnesses.push(harness);

    await harness.execute("timestamped");

    await expect(harness.ping()).resolves.toMatchObject({ lastNavigationAt: 1_234 });
  });

  it("serializes workspace execution requests", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);

    const first = harness.execute("first");
    await executor.started(1);
    const second = harness.execute("second");
    await Promise.resolve();
    expect(executor.startedCount).toBe(1);
    executor.complete(0);
    await first;
    await executor.started(2);
    executor.complete(1);
    await second;
  });

  it("executes disconnected active and queued accepted requests once in FIFO order", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);

    const first = await harness.admit("first", ["overview", "first.ts"]);
    await executor.started(1);
    const second = await harness.admit("second", ["overview", "second.ts"]);
    first.disconnect();
    second.disconnect();

    executor.complete(0);
    await executor.started(2);
    executor.complete(1);
    await waitUntil(async () => (await harness.status("second")).status.state === "completed");

    expect(executor.requests.map((execution) => execution.argv.at(-1))).toEqual([
      "first.ts",
      "second.ts",
    ]);
    expect(first.frames).toHaveLength(1);
    expect(second.frames).toHaveLength(1);
  });

  it("attaches identical duplicate identifiers without duplicate execution", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);

    const first = await harness.admit("duplicate", ["overview", "input.ts"]);
    await executor.started(1);
    const duplicate = await harness.admit("duplicate", ["overview", "input.ts"]);
    const corrupted = await harness.admit("duplicate", ["overview", "other.ts"]);
    executor.complete(0);
    await Promise.all([first.terminal, duplicate.terminal]);

    expect(executor.startedCount).toBe(1);
    expect(first.frames.map((frame) => ("kind" in frame ? frame.kind : "chunk"))).toEqual([
      "accepted",
      "result-manifest",
      "result-end",
    ]);
    expect(duplicate.frames.map((frame) => ("kind" in frame ? frame.kind : "chunk"))).toEqual([
      "accepted",
      "result-manifest",
      "result-end",
    ]);
    expect(corrupted.frames).toEqual([
      expect.objectContaining({ kind: "rejected", retrySafe: false }),
    ]);
  });

  it("reports unknown, queued, running, completed, and failed execution status", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);

    expect((await harness.status("missing")).status).toEqual({ state: "unknown" });
    const active = await harness.admit("active");
    await executor.started(1);
    expect((await harness.status("active")).status).toMatchObject({ state: "running" });
    const queued = await harness.admit("queued");
    expect((await harness.status("queued")).status).toMatchObject({
      state: "queued",
      queuePosition: 1,
    });
    executor.complete(0);
    await executor.started(2);
    executor.complete(1);
    await Promise.all([active.terminal, queued.terminal]);
    expect((await harness.status("active")).status).toEqual({ state: "completed" });

    const failedHarness = await RequestHarness.start(new RejectingExecutor());
    harnesses.push(failedHarness);
    const failed = await failedHarness.admit("failed");
    await failed.terminal;
    expect((await failedHarness.status("failed")).status).toEqual({
      state: "failed",
      code: "internal",
    });
  });

  it("keeps serving after a result exceeds daemon completion capacity", async () => {
    const harness = await RequestHarness.start(new SequencedOutputExecutor(), {
      completionSpoolLimits: { inlineBytes: 0, maximumResultBytes: 1 },
    });
    harnesses.push(harness);

    await expect(harness.execute("too-large")).resolves.toMatchObject({
      kind: "execution-failed",
      code: "response-capacity",
    });
    await expect(harness.ping()).resolves.toMatchObject({ kind: "pong", state: "ready" });
    await expect(harness.execute("small")).resolves.toMatchObject({ kind: "result-end" });
  });

  it("keeps one result chunk in flight while the attachment sink is stalled", async () => {
    const harness = await RequestHarness.start(new MultipleRecordExecutor());
    harnesses.push(harness);
    const stalled = harness.transport.stallNextResultChunk();

    const connection = await harness.admit("stalled-result");
    await stalled.started;

    expect(stalled.maximumInFlight()).toBe(1);
    expect(connection.frames.some((frame) => "kind" in frame && frame.kind === "result-end")).toBe(
      false,
    );
    stalled.release();
    await expect(connection.terminal).resolves.toMatchObject({ kind: "result-end" });
    expect(connection.frames.filter((frame) => !("kind" in frame))).toHaveLength(3);
  });

  it("fails a completion cleanly after spool sync failure and keeps serving", async () => {
    const harness = await RequestHarness.start(new MultipleRecordExecutor(), {
      completionSpoolLimits: { inlineBytes: 0, maximumAggregateBytes: 11 },
      completionSpoolStorage: new RequestFailingCompletionStorage("sync"),
    });
    harnesses.push(harness);

    await expect(harness.execute("sync-failure")).resolves.toMatchObject({
      kind: "execution-failed",
      code: "internal",
    });
    expect((await harness.status("sync-failure")).status).toEqual({
      state: "failed",
      code: "internal",
    });
    await expect(harness.ping()).resolves.toMatchObject({ kind: "pong", state: "ready" });
    await expect(harness.execute("after-sync-failure")).resolves.toMatchObject({
      kind: "result-end",
    });
  });

  it("maps completion read failure to one controlled result and keeps serving", async () => {
    const harness = await RequestHarness.start(new MultipleRecordExecutor(), {
      completionSpoolLimits: { inlineBytes: 0, maximumAggregateBytes: 11 },
      completionSpoolStorage: new RequestFailingCompletionStorage("read"),
    });
    harnesses.push(harness);

    await expect(harness.execute("read-failure")).resolves.toMatchObject({
      kind: "execution-failed",
      code: "internal",
    });
    expect((await harness.status("read-failure")).status).toEqual({
      state: "failed",
      code: "internal",
    });
    await expect(harness.ping()).resolves.toMatchObject({ kind: "pong", state: "ready" });
    await expect(harness.execute("after-read-failure")).resolves.toMatchObject({
      kind: "result-end",
    });
  });

  it("acknowledges logical cleanup when physical unlink fails and keeps serving", async () => {
    const harness = await RequestHarness.start(new MultipleRecordExecutor(), {
      completionSpoolLimits: { inlineBytes: 0, maximumAggregateBytes: 11 },
      completionSpoolStorage: new RequestFailingCompletionStorage("unlink"),
    });
    harnesses.push(harness);
    const completed = await harness.execute("unlink-failure");
    if (completed.kind !== "result-end") throw new Error("Expected completed result");

    await expect(
      harness.acknowledge("unlink-failure", completed.transferId),
    ).resolves.toMatchObject({
      kind: "result-acknowledged",
    });
    await expect(harness.ping()).resolves.toMatchObject({ kind: "pong", state: "ready" });
    await expect(harness.execute("after-unlink-failure")).resolves.toMatchObject({
      kind: "result-end",
    });
  });

  it("reports active command and queued count while worker execution is blocked", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);
    const first = harness.execute("first", ["refs", "input"]);
    await executor.started(1);
    const second = harness.execute("second", ["overview", "input.ts"]);

    const pingStartedAt = Date.now();
    await expect(harness.ping()).resolves.toMatchObject({
      kind: "pong",
      state: "busy",
      currentCommand: "refs",
      queued: 1,
      activity: {
        lifecycle: "busy",
        current: {
          requestId: "first",
          command: "refs",
          elapsedMs: expect.any(Number),
        },
        queued: 1,
      },
    });
    expect(Date.now() - pingStartedAt).toBeLessThan(1_000);

    executor.complete(0);
    await first;
    await executor.started(2);
    executor.complete(1);
    await second;
  });

  it("acknowledges graceful stop requests", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await expect(harness.stop()).resolves.toEqual({
      kind: "stopped",
      instanceId: harness.instanceId,
    });
  });

  it("reports draining from the main thread while admitted work completes", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);
    const execution = harness.execute("draining", ["graph", "input"]);
    await executor.started(1);

    const stopping = harness.stop();
    await expect(harness.ping()).resolves.toMatchObject({
      kind: "pong",
      activity: { lifecycle: "draining", current: { requestId: "draining" } },
    });

    executor.complete(0);
    await execution;
    await stopping;
  });

  it("force-terminates blocked worker execution with one controlled result", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);
    const execution = harness.execute("blocked", ["refs", "input"]);
    await executor.started(1);

    await expect(harness.kill()).resolves.toEqual({
      kind: "killing",
      instanceId: harness.instanceId,
      processToken: harness.processToken,
    });
    await expect(execution).resolves.toEqual({
      kind: "execution-failed",
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      requestId: "blocked",
      code: "stopping",
    });
    await harness.exited;
    expect(harness.registry.read(harness.identity)).toMatchObject({
      processToken: harness.processToken,
    });
  });

  it("closes transport while leaving ready ownership for an exit observer", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await harness.stop();
    await harness.exited;

    expect(harness.registry.read(harness.identity)).toMatchObject({
      processToken: harness.processToken,
    });
    expect(harness.transport.isListening).toBe(false);
  });

  it("records worker freshness diagnostics for every execution turn", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await harness.execute("refresh", ["overview", "input.ts"]);

    await waitUntil(
      () => harness.logEvents().filter((event) => event.kind === "freshness").length === 2,
    );
    expect(harness.logEvents().filter((event) => event.kind === "freshness")).toHaveLength(2);
  });

  it("records ordered execution and delivery terminals for one request", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await harness.execute("observed", ["refs", "private-symbol"]);
    await waitUntil(() =>
      harness.logEvents().some((event) => event.kind === "delivery-terminal"),
    );

    const operationEvents = harness
      .logEvents()
      .filter((event) => event.requestId === "observed")
      .map((event) => event.kind);
    expect(operationEvents).toEqual([
      "request-accepted",
      "turn-started",
      "worker-completed",
      "response-spooled",
      "execution-terminal",
      "delivery-terminal",
    ]);
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "execution-terminal",
          requestId: "observed",
          outcome: "completed",
          serviceMs: expect.any(Number),
          processRssBytes: expect.any(Number),
        }),
        expect.objectContaining({
          kind: "delivery-terminal",
          requestId: "observed",
          outcome: "delivered",
          deliveryMs: expect.any(Number),
        }),
      ]),
    );
  });

  it("reports retained spool bytes until completion acknowledgement", async () => {
    const harness = await RequestHarness.start(new MultipleRecordExecutor());
    harnesses.push(harness);

    const completed = await harness.execute("retained-spool");
    if (completed.kind !== "result-end") throw new Error("Expected completed result");
    await waitUntil(async () => {
      const pong = await harness.ping();
      return pong.kind === "pong" && (pong.activity?.spoolBytes ?? 0) > 0;
    });
    await expect(
      harness.acknowledge("retained-spool", completed.transferId),
    ).resolves.toMatchObject({ kind: "result-acknowledged" });
  });

  it("logs startup failures before rethrowing them", async () => {
    const { daemon, harness, lease } = RequestHarness.create(new ImmediateExecutor());
    harnesses.push(harness);
    harness.transport.listenError = new Error("listen failed");

    await expect(daemon.start()).rejects.toThrow("listen failed");
    lease.release();

    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "failure",
          operation: "start",
          failureCode: "operation-failed",
          errorName: "Error",
        }),
      ]),
    );
  });

  it("does not mutate registry ownership during process-local shutdown", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);
    const remove = vi.spyOn(harness.registry, "removeIfProcess");

    await harness.stop();
    await harness.exited;

    expect(harness.transport.isListening).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("exits after transport cleanup fails", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);
    harness.transport.closeError = new Error("transport cleanup failed");

    await harness.stop();
    await harness.exited;

    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "failure",
          operation: "transport-close",
          failureCode: "operation-failed",
          errorName: "Error",
        }),
      ]),
    );
  });

  it("shuts down when the navigation worker exits unexpectedly", async () => {
    const worker = new ExecutorNavigationWorker(new ImmediateExecutor());
    const harness = await RequestHarness.start(undefined, { navigationWorker: worker });
    harnesses.push(harness);

    worker.fail({ generation: worker.generation, cause: "error", errorName: "WorkerError" });

    await expect(harness.exited).resolves.toBe(0);
    expect(harness.transport.isListening).toBe(false);
    expect(harness.registry.read(harness.identity)).toMatchObject({
      processToken: harness.processToken,
    });
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "failure",
          operation: "worker-exit",
          failureCode: "worker-exit",
          errorName: "UnknownError",
        }),
      ]),
    );
  });

  it("observes an unexpected exit from a non-initial worker generation", async () => {
    const worker = new ExecutorNavigationWorker(new ImmediateExecutor(), 7);
    const harness = await RequestHarness.start(undefined, { navigationWorker: worker });
    harnesses.push(harness);

    worker.fail({ generation: worker.generation, cause: "error", errorName: "WorkerError" });

    await expect(harness.exited).resolves.toBe(0);
    expect(harness.transport.isListening).toBe(false);
  });

  it("fails active work once and preserves queued FIFO across worker replacement", async () => {
    const activeExecutor = new SerializedExecutor();
    const replacementExecutor = new RecordingExecutor();
    const workers: ExecutorNavigationWorker[] = [];
    const harness = await RequestHarness.start(undefined, {
      navigationWorkerFactory: (generation) => {
        const worker = new ExecutorNavigationWorker(
          generation === 1 ? activeExecutor : replacementExecutor,
          generation,
        );
        workers.push(worker);
        return worker;
      },
    });
    harnesses.push(harness);
    const active = harness.execute("active", ["refs", "input"]);
    await activeExecutor.started(1);
    const queued = harness.execute("queued", ["overview", "input.ts"]);
    await expect(harness.ping()).resolves.toMatchObject({ state: "busy", queued: 1 });

    workers[0]?.fail({ generation: 1, cause: "out-of-memory", errorName: "WorkerOom" });

    await expect(active).resolves.toMatchObject({
      kind: "execution-failed",
      requestId: "active",
      code: "controlled-resource",
    });
    await expect(queued).resolves.toMatchObject({ kind: "result-end", requestId: "queued" });
    expect(activeExecutor.requests).toHaveLength(1);
    expect(replacementExecutor.requests).toHaveLength(1);
    expect(workers.map((worker) => worker.generation)).toEqual([1, 2]);
    await expect(harness.ping()).resolves.toMatchObject({ state: "ready" });
    expect(harness.registry.read(harness.identity)).toMatchObject({
      pid: process.pid,
      instanceId: harness.instanceId,
      processToken: harness.processToken,
    });

    workers[0]?.fail({ generation: 1, cause: "error", errorName: "LateOldGeneration" });
    await expect(harness.ping()).resolves.toMatchObject({ state: "ready" });
    expect(workers).toHaveLength(2);
  });

  it("completes scheduled shedding before the next queued worker turn", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(1024 * 1024 * 1024);
    let residentMemoryBytes = 0;
    const executor = new SerializedExecutor();
    const worker = new ReleaseGatedNavigationWorker(executor);
    const harness = await RequestHarness.start(undefined, {
      navigationWorker: worker,
      resourcePolicy: policy,
      resourceCheckIntervalMs: 5,
      residentMemoryBytes: () => residentMemoryBytes,
    });
    harnesses.push(harness);
    const first = harness.execute("first", ["refs", "input"]);
    await executor.started(1);
    const second = harness.execute("second", ["overview", "input.ts"]);
    await waitUntil(async () => {
      const response = await harness.ping();
      return response.kind === "pong" && response.queued === 1;
    });

    residentMemoryBytes = policy.record.softProcessRssBytes + 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(worker.releaseCount).toBe(0);
    executor.complete(0);
    await worker.releaseStarted;
    expect(executor.startedCount).toBe(1);
    await expect(harness.ping()).resolves.toMatchObject({
      kind: "pong",
      activity: { lifecycle: "recovering", queued: 1 },
    });

    worker.allowRelease();
    await executor.started(2);
    executor.complete(1);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: "result-end", requestId: "first" }),
      expect.objectContaining({ kind: "result-end", requestId: "second" }),
    ]);
    expect(worker.releaseCount).toBe(1);
  });

  it("replaces a failed shed before releasing queued work", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(1024 * 1024 * 1024);
    let residentMemoryBytes = 0;
    const firstExecutor = new SerializedExecutor();
    const replacementExecutor = new RecordingExecutor();
    const workers: ExecutorNavigationWorker[] = [];
    const harness = await RequestHarness.start(undefined, {
      navigationWorkerFactory: (generation) => {
        const worker =
          generation === 1
            ? new ReleaseFailingNavigationWorker(firstExecutor, generation)
            : new ExecutorNavigationWorker(replacementExecutor, generation);
        workers.push(worker);
        return worker;
      },
      resourcePolicy: policy,
      resourceCheckIntervalMs: 5,
      residentMemoryBytes: () => residentMemoryBytes,
    });
    harnesses.push(harness);
    const first = harness.execute("first", ["refs", "input"]);
    await firstExecutor.started(1);
    const second = harness.execute("second", ["overview", "input.ts"]);
    await waitUntil(async () => {
      const response = await harness.ping();
      return response.kind === "pong" && response.queued === 1;
    });

    residentMemoryBytes = policy.record.softProcessRssBytes + 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    firstExecutor.complete(0);
    await waitUntil(() => workers.length === 2);

    await expect(first).resolves.toMatchObject({ kind: "result-end", requestId: "first" });
    await expect(second).resolves.toMatchObject({ kind: "result-end", requestId: "second" });
    expect(firstExecutor.requests).toHaveLength(1);
    expect(replacementExecutor.requests).toHaveLength(1);
    expect(workers.map((worker) => worker.generation)).toEqual([1, 2]);
    await expect(harness.ping()).resolves.toMatchObject({ state: "ready" });
  });

  it("sheds pressure first observed at turn completion before the next turn", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(1024 * 1024 * 1024);
    let residentMemoryBytes = 0;
    const executor = new SerializedExecutor();
    const worker = new ReleaseGatedNavigationWorker(executor);
    const harness = await RequestHarness.start(undefined, {
      navigationWorker: worker,
      resourcePolicy: policy,
      resourceCheckIntervalMs: 60_000,
      residentMemoryBytes: () => residentMemoryBytes,
    });
    harnesses.push(harness);
    const first = harness.execute("turn-complete-first", ["refs", "input"]);
    await executor.started(1);
    const second = harness.execute("queued-after-pressure", ["overview", "input.ts"]);
    await waitUntil(async () => {
      const response = await harness.ping();
      return response.kind === "pong" && response.queued === 1;
    });

    residentMemoryBytes = policy.record.softProcessRssBytes + 1;
    executor.complete(0);
    await worker.releaseStarted;
    expect(worker.releaseCount).toBe(1);
    expect(executor.startedCount).toBe(1);

    worker.allowRelease();
    await executor.started(2);
    executor.complete(1);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: "result-end", requestId: "turn-complete-first" }),
      expect.objectContaining({ kind: "result-end", requestId: "queued-after-pressure" }),
    ]);
    await expect(harness.stop()).resolves.toMatchObject({ kind: "stopped" });
    await expect(harness.exited).resolves.toBe(0);
  });

  it("replaces a failed turn-completion shed before the queued turn", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(1024 * 1024 * 1024);
    let residentMemoryBytes = 0;
    const firstExecutor = new SerializedExecutor();
    const replacementExecutor = new RecordingExecutor();
    const workers: ExecutorNavigationWorker[] = [];
    const harness = await RequestHarness.start(undefined, {
      navigationWorkerFactory: (generation) => {
        const worker =
          generation === 1
            ? new ReleaseFailingNavigationWorker(firstExecutor, generation)
            : new ExecutorNavigationWorker(replacementExecutor, generation);
        workers.push(worker);
        return worker;
      },
      resourcePolicy: policy,
      resourceCheckIntervalMs: 60_000,
      residentMemoryBytes: () => residentMemoryBytes,
    });
    harnesses.push(harness);
    const first = harness.execute("failed-turn-complete-shed", ["refs", "input"]);
    await firstExecutor.started(1);
    const second = harness.execute("queued-after-replacement", ["overview", "input.ts"]);

    residentMemoryBytes = policy.record.softProcessRssBytes + 1;
    firstExecutor.complete(0);
    await waitUntil(() => workers.length === 2);

    await expect(first).resolves.toMatchObject({
      kind: "result-end",
      requestId: "failed-turn-complete-shed",
    });
    await expect(second).resolves.toMatchObject({
      kind: "result-end",
      requestId: "queued-after-replacement",
    });
    expect(firstExecutor.requests).toHaveLength(1);
    expect(replacementExecutor.requests).toHaveLength(1);
    expect(workers.map((worker) => worker.generation)).toEqual([1, 2]);
    await expect(harness.stop()).resolves.toMatchObject({ kind: "stopped" });
    await expect(harness.exited).resolves.toBe(0);
  });

  it("recovers one real worker old-generation exhaustion during warm-up", async () => {
    const generations: number[] = [];
    const { daemon, harness, lease } = RequestHarness.create(undefined, {
      navigationWorkerFactory: (generation) => {
        generations.push(generation);
        return new NodeDaemonNavigationWorker({
          generation,
          configuration: { stateDirectory: "/state" },
          entryUrl: new URL(
            "../../test/helpers/daemon-navigation-worker-fixture.mjs",
            import.meta.url,
          ),
          workerData: { mode: generation === 1 ? "initialize-heap-oom" : "normal" },
          resourceLimits: { maxOldGenerationSizeMb: 24 },
        });
      },
    });
    harnesses.push(harness);

    await daemon.start();
    lease.release();

    expect(generations).toEqual([1, 2]);
    await expect(harness.ping()).resolves.toMatchObject({ state: "ready" });
    await expect(harness.execute("after-warmup-pressure")).resolves.toMatchObject({
      kind: "result-end",
    });
  }, 10_000);

  it("sheds soft pressure before warm-up publishes readiness", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(1024 * 1024 * 1024);
    const worker = new ReleaseGatedNavigationWorker(new ImmediateExecutor());
    const { daemon, harness, lease } = RequestHarness.create(undefined, {
      navigationWorker: worker,
      resourcePolicy: policy,
      residentMemoryBytes: () => policy.record.softProcessRssBytes + 1,
    });
    harnesses.push(harness);
    let ready = false;
    const starting = daemon.start().then(() => {
      ready = true;
    });

    await worker.releaseStarted;
    expect(ready).toBe(false);
    expect(harness.registry.read(harness.identity)?.state).toBe("starting");
    worker.allowRelease();
    await starting;
    lease.release();

    await expect(harness.ping()).resolves.toMatchObject({ state: "ready" });
  });

  it("recovers a real old-generation exhaustion without replaying active work", async () => {
    const harness = await RequestHarness.start(undefined, {
      navigationWorkerFactory: (generation) =>
        new NodeDaemonNavigationWorker({
          generation,
          configuration: { stateDirectory: "/state" },
          entryUrl: new URL(
            "../../test/helpers/daemon-navigation-worker-fixture.mjs",
            import.meta.url,
          ),
          workerData: { mode: generation === 1 ? "heap-oom" : "normal" },
          resourceLimits: { maxOldGenerationSizeMb: 24 },
        }),
    });
    harnesses.push(harness);

    const active = harness.execute("heap-active", ["refs", "input"]);
    const queued = harness.execute("heap-queued", ["overview", "input.ts"]);

    await expect(active).resolves.toMatchObject({
      kind: "execution-failed",
      requestId: "heap-active",
      code: "controlled-resource",
    });
    await expect(queued).resolves.toMatchObject({
      kind: "result-end",
      requestId: "heap-queued",
    });
    await expect(harness.ping()).resolves.toMatchObject({ state: "ready" });
    expect(harness.registry.read(harness.identity)).toMatchObject({ pid: process.pid });
  }, 10_000);

  it("recovers real external RSS pressure while lifecycle control stays responsive", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(512 * 1024 * 1024);
    const harness = await RequestHarness.start(undefined, {
      resourcePolicy: policy,
      resourceCheckIntervalMs: 25,
      navigationWorkerFactory: (generation) =>
        new NodeDaemonNavigationWorker({
          generation,
          configuration: { stateDirectory: "/state" },
          entryUrl: new URL(
            "../../test/helpers/daemon-navigation-worker-fixture.mjs",
            import.meta.url,
          ),
          workerData: { mode: generation === 1 ? "external-pressure" : "normal" },
          resourceLimits: { maxOldGenerationSizeMb: 64 },
        }),
    });
    harnesses.push(harness);

    const active = harness.execute("rss-active", ["refs", "input"]);
    const queued = harness.execute("rss-queued", ["overview", "input.ts"]);
    await waitUntil(async () => {
      const response = await harness.ping();
      return response.kind === "pong" && response.state === "busy";
    });
    await expect(harness.ping()).resolves.toMatchObject({ state: "busy" });

    await expect(active).resolves.toMatchObject({
      kind: "execution-failed",
      requestId: "rss-active",
      code: "controlled-resource",
    });
    await expect(queued).resolves.toMatchObject({ kind: "result-end", requestId: "rss-queued" });
    await expect(harness.ping()).resolves.toMatchObject({ state: "ready" });
    expect(harness.registry.read(harness.identity)).toMatchObject({ pid: process.pid });
  }, 10_000);
});

class RequestHarness {
  readonly stateDirectory = mkdtempSync(join(tmpdir(), "symnav-request-state-"));
  readonly workspaceRoot = mkdtempSync(join(tmpdir(), "symnav-request-workspace-"));
  readonly identity: DaemonWorkspaceIdentity;
  readonly registry: DaemonRegistry;
  readonly transport = new RequestTransport();
  readonly instanceId = "request-instance";
  readonly processToken = "request-token";
  readonly exited: Promise<number>;
  private resolveExit!: (code: number) => void;

  private constructor() {
    mkdirSync(join(this.workspaceRoot, ".git"));
    writeFileSync(join(this.workspaceRoot, "input.ts"), "export const value = 1;\n");
    this.identity = DaemonWorkspaceIdentity.from(this.workspaceRoot, this.stateDirectory);
    this.registry = new DaemonRegistry(this.identity.registryDirectory);
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  static async start(
    executor: DaemonCommandExecutor | undefined,
    options: RequestHarnessOptions = {},
  ): Promise<RequestHarness> {
    const { daemon, harness, lease } = RequestHarness.create(executor, options);
    await daemon.start();
    lease.release();
    return harness;
  }

  static create(
    executor: DaemonCommandExecutor | undefined,
    options: RequestHarnessOptions = {},
  ): {
    readonly daemon: WorkspaceDaemon;
    readonly harness: RequestHarness;
    readonly lease: NonNullable<ReturnType<DaemonRegistry["acquireStartup"]>>;
  } {
    const harness = new RequestHarness();
    const lease = harness.registry.acquireStartup(harness.identity, {
      identityKey: harness.identity.identityKey,
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      ownerPid: process.pid,
      ownerKind: "launcher",
      heartbeatAt: Date.now(),
    });
    if (lease === undefined) throw new Error("Expected startup ownership");
    harness.registry.write({
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: "test",
      workspaceRoot: harness.workspaceRoot,
      workspaceKey: harness.identity.workspaceKey,
      stateKey: harness.identity.stateKey,
      identityKey: harness.identity.identityKey,
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      endpoint: harness.identity.endpoint(harness.instanceId),
      pid: process.pid,
      state: "starting",
      startedAt: Date.now(),
      memoryCapBytes: 1024,
    });
    const navigationWorker =
      options.navigationWorker ??
      (options.navigationWorkerFactory === undefined
        ? new ExecutorNavigationWorker(executor ?? new ImmediateExecutor())
        : undefined);
    const daemon = new WorkspaceDaemon({
      identity: harness.identity,
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      symnavVersion: "test",
      memoryCapBytes: 1024,
      dependencies: createDefaultDependencies(harness.identity.stateDirectory),
      registry: harness.registry,
      transport: harness.transport as unknown as LocalDaemonTransport,
      ...(navigationWorker === undefined ? {} : { navigationWorker }),
      ...(options.navigationWorkerFactory === undefined
        ? {}
        : { navigationWorkerFactory: options.navigationWorkerFactory }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.startupHeartbeatIntervalMs === undefined
        ? {}
        : { startupHeartbeatIntervalMs: options.startupHeartbeatIntervalMs }),
      ...(options.completionSpoolLimits === undefined
        ? {}
        : { completionSpoolLimits: options.completionSpoolLimits }),
      ...(options.completionSpoolStorage === undefined
        ? {}
        : { completionSpoolStorage: options.completionSpoolStorage }),
      ...(options.resourcePolicy === undefined ? {} : { resourcePolicy: options.resourcePolicy }),
      ...(options.resourceCheckIntervalMs === undefined
        ? {}
        : { resourceCheckIntervalMs: options.resourceCheckIntervalMs }),
      ...(options.residentMemoryBytes === undefined
        ? {}
        : { residentMemoryBytes: options.residentMemoryBytes }),
      exit: (code) => harness.resolveExit(code),
    });
    return { daemon, harness, lease };
  }

  identify(): Promise<DaemonResponse> {
    return this.transport.receive({
      kind: "identify",
      instanceId: this.instanceId,
      processToken: this.processToken,
    });
  }

  terminate(): Promise<DaemonResponse> {
    return this.transport.receive({
      kind: "terminate",
      instanceId: this.instanceId,
      processToken: this.processToken,
    });
  }

  ping(): Promise<DaemonResponse> {
    return this.transport.receive({
      kind: "ping",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
    });
  }

  execute(requestId: string, argv: readonly string[] = ["--version"]): Promise<DaemonResponse> {
    return this.admit(requestId, argv).then((connection) => connection.terminal);
  }

  admit(requestId: string, argv: readonly string[] = ["--version"]): Promise<RequestConnection> {
    return this.transport.connect({
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      processToken: this.processToken,
      requestId,
      request: { argv, cwd: this.workspaceRoot, telemetryEnabled: false },
    });
  }

  status(requestId: string): Promise<DaemonExecutionStatusResponse> {
    return this.transport.receive({
      kind: "execution-status",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      processToken: this.processToken,
      requestId,
    }) as Promise<DaemonExecutionStatusResponse>;
  }

  acknowledge(requestId: string, transferId: string): Promise<DaemonResponse> {
    return this.transport.receive({
      kind: "result-ack",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      processToken: this.processToken,
      requestId,
      transferId,
    });
  }

  stop(): Promise<DaemonResponse> {
    return this.transport.receive({
      kind: "stop",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
    });
  }

  kill(): Promise<DaemonResponse> {
    return this.transport.receive({
      kind: "kill",
      instanceId: this.instanceId,
      processToken: this.processToken,
    });
  }

  logEvents(): readonly Record<string, unknown>[] {
    return readFileSync(this.identity.logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  async dispose(): Promise<void> {
    if (this.transport.isListening) {
      await this.transport
        .receive({ kind: "kill", instanceId: this.instanceId, processToken: this.processToken })
        .catch(() => undefined);
      await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 100))]);
    }
    rmSync(this.stateDirectory, { recursive: true, force: true });
    rmSync(this.workspaceRoot, { recursive: true, force: true });
  }
}

interface RequestHarnessOptions {
  readonly now?: () => number;
  readonly navigationWorker?: DaemonNavigationWorker;
  readonly navigationWorkerFactory?: (generation: number) => DaemonNavigationWorker;
  readonly resourcePolicy?: DaemonResourcePolicy;
  readonly resourceCheckIntervalMs?: number;
  readonly residentMemoryBytes?: () => number;
  readonly startupHeartbeatIntervalMs?: number;
  readonly completionSpoolLimits?: WorkspaceDaemonOptions["completionSpoolLimits"];
  readonly completionSpoolStorage?: WorkspaceDaemonOptions["completionSpoolStorage"];
}

class RequestTransport {
  private handler:
    | ((
        request: DaemonRequest,
        send: (response: DaemonServerMessage) => Promise<void>,
      ) => Promise<DaemonResponse | void>)
    | undefined;
  listenError: Error | undefined;
  closeError: Error | undefined;
  private resultChunkGate:
    | {
        readonly started: () => void;
        readonly wait: Promise<void>;
      }
    | undefined;
  private resultChunksInFlight = 0;
  private maximumResultChunksInFlight = 0;

  get isListening(): boolean {
    return this.handler !== undefined;
  }

  async listen(
    _endpoint: string,
    handler: (
      request: DaemonRequest,
      send: (response: DaemonServerMessage) => Promise<void>,
    ) => Promise<DaemonResponse | void>,
  ): Promise<DaemonServer> {
    if (this.listenError !== undefined) throw this.listenError;
    this.handler = handler;
    return {
      close: async () => {
        this.handler = undefined;
        if (this.closeError !== undefined) throw this.closeError;
      },
    };
  }

  async receive(request: DaemonRequest): Promise<DaemonResponse> {
    if (this.handler === undefined) return Promise.reject(new Error("Transport is not listening"));
    const response = await this.handler(request, async () => undefined);
    if (response === undefined) throw new Error("Transport handler returned no response");
    return response;
  }

  async connect(request: DaemonRequest): Promise<RequestConnection> {
    if (this.handler === undefined) throw new Error("Transport is not listening");
    const frames: DaemonServerMessage[] = [];
    let connected = true;
    let resolveTerminal!: (frame: DaemonExecutionServerFrame) => void;
    const terminal = new Promise<DaemonExecutionServerFrame>((resolve) => {
      resolveTerminal = resolve;
    });
    const receive = async (response: DaemonServerMessage): Promise<void> => {
      if (!("kind" in response) && this.resultChunkGate !== undefined) {
        this.resultChunksInFlight += 1;
        this.maximumResultChunksInFlight = Math.max(
          this.maximumResultChunksInFlight,
          this.resultChunksInFlight,
        );
        this.resultChunkGate.started();
        await this.resultChunkGate.wait;
        this.resultChunksInFlight -= 1;
      }
      if (!connected) return;
      frames.push(response);
      if (!RequestTransport.isExecutionFrame(response)) return;
      if (
        response.kind === "rejected" ||
        response.kind === "result-end" ||
        response.kind === "execution-failed"
      ) {
        resolveTerminal(response);
      }
    };
    const response = await this.handler(request, receive);
    if (response !== undefined) await receive(response);
    return {
      frames,
      terminal,
      disconnect: () => {
        connected = false;
      },
    };
  }

  stallNextResultChunk(): {
    readonly started: Promise<void>;
    readonly release: () => void;
    readonly maximumInFlight: () => number;
  } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.resultChunkGate = { started: markStarted, wait };
    return {
      started,
      release,
      maximumInFlight: () => this.maximumResultChunksInFlight,
    };
  }

  private static isExecutionFrame(
    response: DaemonServerMessage,
  ): response is DaemonExecutionServerFrame {
    if (!("kind" in response)) return false;
    return (
      response.kind === "accepted" ||
      response.kind === "rejected" ||
      response.kind === "result-manifest" ||
      response.kind === "result-end" ||
      response.kind === "execution-failed"
    );
  }
}

interface RequestConnection {
  readonly frames: DaemonServerMessage[];
  readonly terminal: Promise<DaemonExecutionServerFrame>;
  disconnect(): void;
}

interface DaemonCommandExecutor {
  execute(request: CliExecutionRequest): Promise<CommandExecutionResult>;
}

class ImmediateExecutor implements DaemonCommandExecutor {
  async execute(_request: CliExecutionRequest): Promise<CommandExecutionResult> {
    return emptyResult();
  }
}

class RecordingExecutor implements DaemonCommandExecutor {
  readonly requests: CliExecutionRequest[] = [];

  async execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    this.requests.push(request);
    return emptyResult();
  }
}

class SerializedExecutor implements DaemonCommandExecutor {
  private readonly results: (() => void)[] = [];
  readonly requests: CliExecutionRequest[] = [];

  get startedCount(): number {
    return this.results.length;
  }

  async execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    this.requests.push(request);
    await new Promise<void>((resolve) => this.results.push(resolve));
    return emptyResult();
  }

  async started(count: number): Promise<void> {
    while (this.results.length < count) await Promise.resolve();
  }

  complete(index: number): void {
    this.results[index]?.();
  }
}

class RejectingExecutor implements DaemonCommandExecutor {
  execute(): Promise<CommandExecutionResult> {
    return Promise.reject(new Error("execution failed"));
  }
}

class SequencedOutputExecutor implements DaemonCommandExecutor {
  private executionCount = 0;

  execute(): Promise<CommandExecutionResult> {
    this.executionCount += 1;
    const records =
      this.executionCount === 1 ? [{ stream: "stdout" as const, bytes: Buffer.from("xx") }] : [];
    return Promise.resolve({ output: new CommandOutputSnapshot(records), exitCode: 0 });
  }
}

class MultipleRecordExecutor implements DaemonCommandExecutor {
  execute(): Promise<CommandExecutionResult> {
    return Promise.resolve({
      output: new CommandOutputSnapshot([
        { stream: "stdout", bytes: Buffer.from("one") },
        { stream: "stderr", bytes: Buffer.from("two") },
        { stream: "stdout", bytes: Buffer.from("three") },
      ]),
      exitCode: 0,
    });
  }
}

class RequestFailingCompletionStorage extends NodeCompletionSpoolStorage {
  private failed = false;

  constructor(private readonly operation: "sync" | "read" | "unlink") {
    super();
  }

  override async createFile(path: string): Promise<CompletionSpoolFile> {
    const file = await super.createFile(path);
    return {
      write: (bytes) => file.write(bytes),
      sync: async () => {
        if (this.fail("sync")) throw new Error("sync failed");
        await file.sync();
      },
      close: () => file.close(),
    };
  }

  override async *records(path: string): AsyncIterable<CommandOutputRecord> {
    if (this.fail("read")) throw new Error("read failed");
    for await (const record of super.records(path)) yield record;
  }

  override async unlink(path: string): Promise<void> {
    if (this.fail("unlink")) throw new Error("unlink failed");
    await super.unlink(path);
  }

  private fail(operation: "sync" | "read" | "unlink"): boolean {
    if (this.failed || this.operation !== operation) return false;
    this.failed = true;
    return true;
  }
}

function emptyResult(): CommandExecutionResult {
  return { output: new CommandOutputSnapshot([]), exitCode: 0 };
}

class ExecutorNavigationWorker implements DaemonNavigationWorker {
  readonly generation: number;
  readonly exited: Promise<DaemonNavigationWorkerExit>;
  private resolveExited!: (exit: DaemonNavigationWorkerExit) => void;
  private rejectTermination!: (error: Error) => void;
  private readonly termination: Promise<never>;

  constructor(
    private readonly executor: DaemonCommandExecutor,
    generation = 1,
  ) {
    this.generation = generation;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.termination = new Promise((_resolve, reject) => {
      this.rejectTermination = reject;
    });
    void this.termination.catch(() => undefined);
  }

  async start(): Promise<DaemonNavigationWorkerResponse> {
    return {
      kind: "ready",
      generation: this.generation,
      fileCount: 1,
      refresh: { added: 1, changed: 0, removed: 0, unchanged: 0 },
      startupDurations: { discoveryMs: 0, indexingMs: 1, totalMs: 1 },
    };
  }

  async execute(
    requestId: string,
    request: CliExecutionRequest,
    output: Parameters<DaemonNavigationWorker["execute"]>[2],
  ): Promise<DaemonNavigationWorkerResponse> {
    const result = await Promise.race([this.executor.execute(request), this.termination]);
    for await (const record of result.output.records()) await output.append(record);
    await result.output.dispose();
    return {
      kind: "result",
      generation: this.generation,
      requestId,
      result: { exitCode: result.exitCode },
      refresh: { added: 0, changed: 0, removed: 0, unchanged: 1 },
      durations: { freshnessMs: 0, navigationMs: 1, renderMs: 0, outputMs: 0 },
    };
  }

  async releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    return {
      kind: "heap",
      generation: this.generation,
      operationId: "executor-release",
      usedHeapBytes: 1,
      heapLimitBytes: 2,
    };
  }

  drainAndClose(): Promise<void> {
    this.resolveExited({ generation: this.generation, cause: "closed" });
    return Promise.resolve();
  }

  terminate(): Promise<void> {
    this.rejectTermination(new Error("worker terminated"));
    this.resolveExited({ generation: this.generation, cause: "terminated" });
    return Promise.resolve();
  }

  fail(exit: DaemonNavigationWorkerExit): void {
    this.resolveExited(exit);
  }
}

class ReleaseGatedNavigationWorker extends ExecutorNavigationWorker {
  readonly releaseStarted: Promise<void>;
  releaseCount = 0;
  private resolveReleaseStarted!: () => void;
  private releaseAllowed!: () => void;
  private readonly releaseGate: Promise<void>;

  constructor(executor: DaemonCommandExecutor) {
    super(executor);
    this.releaseStarted = new Promise((resolve) => {
      this.resolveReleaseStarted = resolve;
    });
    this.releaseGate = new Promise((resolve) => {
      this.releaseAllowed = resolve;
    });
  }

  override async releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    this.releaseCount += 1;
    this.resolveReleaseStarted();
    await this.releaseGate;
    return {
      kind: "heap",
      generation: this.generation,
      operationId: "gated-release",
      usedHeapBytes: 1,
      heapLimitBytes: 2,
    };
  }

  allowRelease(): void {
    this.releaseAllowed();
  }
}

class ReleaseFailingNavigationWorker extends ExecutorNavigationWorker {
  override releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    return Promise.reject(new Error("release failed"));
  }
}

class DeferredInitializationWorker implements DaemonNavigationWorker {
  readonly generation = 1;
  readonly exited = new Promise<DaemonNavigationWorkerExit>(() => undefined);
  readonly initializationStarted: Promise<void>;
  private resolveInitializationStarted!: () => void;
  private resolveReady!: (response: DaemonNavigationWorkerResponse) => void;
  private readonly ready: Promise<DaemonNavigationWorkerResponse>;

  constructor() {
    this.initializationStarted = new Promise((resolve) => {
      this.resolveInitializationStarted = resolve;
    });
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  start(): Promise<DaemonNavigationWorkerResponse> {
    this.resolveInitializationStarted();
    return this.ready;
  }

  execute(): Promise<DaemonNavigationWorkerResponse> {
    throw new Error("Deferred initialization worker is not executable");
  }

  releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    throw new Error("Deferred initialization worker has no transient resources");
  }

  drainAndClose(): Promise<void> {
    return Promise.resolve();
  }

  terminate(): Promise<void> {
    return Promise.resolve();
  }

  completeInitialization(): void {
    this.resolveReady({
      kind: "ready",
      generation: this.generation,
      fileCount: 1,
      refresh: { added: 1, changed: 0, removed: 0, unchanged: 0 },
      startupDurations: { discoveryMs: 0, indexingMs: 1, totalMs: 1 },
    });
  }
}

class RejectingInitializationWorker extends DeferredInitializationWorker {
  terminateCount = 0;

  override start(): Promise<DaemonNavigationWorkerResponse> {
    return Promise.reject(new Error("initialization failed"));
  }

  override terminate(): Promise<void> {
    this.terminateCount += 1;
    return Promise.resolve();
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for daemon startup state");
}
