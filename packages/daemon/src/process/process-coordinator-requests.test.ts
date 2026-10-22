import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_COMMAND_NAMES, DaemonPolicy, type DaemonCommandName } from "@symnav/daemon";
import {
  CommandOutputSnapshot,
  type CliExecutionRequest,
  type CommandExecutionResult,
  type CommandOutputRecord,
} from "../../test/helpers/executor-output.js";
import { DaemonActivityProjector } from "./activity-projector.js";
import type {
  DaemonExecutionServerFrame,
  DaemonExecutionStatusResponse,
  DaemonRequest,
  DaemonResponse,
  DaemonServerMessage,
  DaemonServer,
} from "../transport/protocol.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_RECORD_SCHEMA_VERSION } from "../transport/protocol.js";
import { DaemonPolicyCodec } from "../daemon-policy.js";
import {
  CompletionSpoolCapacityError,
  NodeCompletionSpoolStorage,
  type CompletionSpoolFile,
} from "../delivery/completion-spool.js";
import { TestDaemonRegistry as DaemonRegistry } from "../../test/helpers/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";
import type { DaemonRequestServer, DaemonServerSend } from "../transport/contracts.js";
import type { AcceptedRequestLedger } from "../execution/accepted-request-ledger.js";
import type { AcceptedExecutionSession } from "../execution/accepted-execution-session.js";
import type {
  DaemonNavigationWorker,
  DaemonNavigationWorkerExit,
} from "../worker/navigation-worker.js";
import {
  DaemonNavigationWorkerExitedError,
  NodeDaemonNavigationWorker,
} from "../worker/navigation-worker.js";
import type { DaemonNavigationWorkerResponse } from "../worker/worker-protocol.js";
import type {
  DaemonResourceSnapshot,
  DaemonResourceSupervisor,
} from "../resources/resource-supervisor.js";
import type { DaemonWorkerGenerationManager } from "../worker/worker-generation-manager.js";
import { TestDaemonResourcePolicy as DaemonResourcePolicy } from "../../test/helpers/daemon-resource-policy.js";
import {
  TestDaemonProcessCoordinator as DaemonProcessCoordinator,
  type TestDaemonProcessCoordinatorOptions as DaemonProcessCoordinatorOptions,
} from "../../test/helpers/daemon-process-coordinator.js";

describe("DaemonProcessCoordinator requests", () => {
  const harnesses: RequestHarness[] = [];

  afterEach(async () => {
    const harnessesToDispose = harnesses.splice(0);
    await Promise.all(harnessesToDispose.map((harness) => harness.dispose()));
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
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "startup-completed",
          workerGeneration: 1,
          fileCount: 1,
          discoveryMs: 0,
          indexingMs: 1,
          totalMs: 1,
        }),
      ]),
    );
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
      fileCount: 0,
      activity: {
        lifecycle: "starting",
        pid: process.pid,
        startupElapsedMs: expect.any(Number),
        queued: 0,
        workerGeneration: 1,
        spoolBytes: 0,
      },
    });
    const startingActivity = startingStatus.kind === "pong" ? startingStatus.activity : undefined;
    if (startingActivity === undefined) {
      throw new Error("Expected daemon activity snapshot");
    }
    expect(startingActivity).not.toHaveProperty("fileCount");
    expect(() => Object.assign(startingActivity, { queued: 9 })).toThrow();
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
    await expect(
      harness.transport.receive({
        kind: "kill",
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

  it.each([
    {
      kind: "execute",
      requestId: "auth-execute",
      commandName: "version",
      request: {
        argv: ["--version"],
        cwd: "/workspace",
        telemetryEnabled: false,
        executionMode: "warm",
      },
    },
    { kind: "execution-status", requestId: "auth-status" },
    { kind: "result-fetch", requestId: "auth-fetch", offset: 0 },
    { kind: "result-ack", requestId: "auth-ack", transferId: "transfer" },
  ] as const)("validates $kind protocol and instance before its token", async (request) => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);
    const authenticatedRequest = {
      ...request,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: harness.instanceId,
      processToken: harness.processToken,
    } as DaemonRequest;
    const withAuthentication = (authentication: {
      readonly protocolVersion?: number;
      readonly instanceId?: string;
      readonly processToken?: string;
    }): DaemonRequest => ({ ...authenticatedRequest, ...authentication }) as DaemonRequest;

    await expect(
      harness.transport.receive(
        withAuthentication({
          protocolVersion: DAEMON_PROTOCOL_VERSION + 1,
          processToken: "wrong-token",
        }),
      ),
    ).rejects.toThrow("protocol or instance");
    await expect(
      harness.transport.receive(
        withAuthentication({
          instanceId: "wrong-instance",
          processToken: "wrong-token",
        }),
      ),
    ).rejects.toThrow("protocol or instance");
    await expect(
      harness.transport.receive(withAuthentication({ processToken: "wrong-token" })),
    ).rejects.toThrow("execution request");
  });

  it("keeps ping and stop authenticated only by protocol and instance", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await expect(harness.ping()).resolves.toMatchObject({ kind: "pong" });
    await expect(harness.stop()).resolves.toEqual({
      kind: "stopped",
      instanceId: harness.instanceId,
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

  it("projects workspace status from explicit daemon snapshots", async () => {
    const project = vi.spyOn(DaemonActivityProjector, "project");
    const harness = await RequestHarness.start(new ImmediateExecutor(), {
      residentMemoryBytes: () => 444,
    });
    harnesses.push(harness);

    const pong = await harness.ping();
    const projectionInput = project.mock.calls[0]?.[0];
    const projected = project.mock.results[0]?.value;

    expect(project).toHaveBeenCalledTimes(1);
    expect(projectionInput).toEqual({
      nowMonotonicMs: expect.any(Number),
      pid: process.pid,
      processRssBytes: expect.any(Number),
      startedAt: expect.any(Number),
      startedMonotonicAt: expect.any(Number),
      productVersion: "test",
      instanceId: harness.instanceId,
      hardProcessRssBytes: expect.any(Number),
      queue: { state: "accepting", queued: 0 },
      resources: {
        state: "ready",
        generation: 1,
        processRssBytes: 444,
        peakProcessRssBytes: 444,
        spoolBytes: 0,
        admissionPaused: false,
        replacementCount: 0,
      },
      worker: { generation: 1, ready: true, fileCount: 1 },
    });
    expect(Object.values(projectionInput ?? {})).not.toContainEqual(expect.any(Function));
    expect(pong).toBe(projected?.pong);
    expect(JSON.stringify(pong)).toBe(JSON.stringify(projected?.pong));
    project.mockRestore();
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

  it("disconnects unauthenticated execution before admission has an effect", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);
    const sample = harness.observeAdmissionSamples();

    await expect(harness.admitWithToken("unauthenticated", "wrong-token")).rejects.toThrow(
      "process instance",
    );

    expect(harness.transport.sentFrames).toEqual([]);
    expect(harness.acceptedRequestCount()).toBe(0);
    expect(sample).not.toHaveBeenCalled();
  });

  it("checks worker readiness before resource admission", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);
    harness.setWorkerReady(false);
    harness.setResourceAdmissionPaused(true);

    const connection = await harness.admit("worker-before-resource");

    await expect(connection.terminal).resolves.toMatchObject({
      kind: "rejected",
      code: "not-ready",
    });
    expect(harness.acceptedRequestCount()).toBe(0);
  });

  it("checks resource admission before queue draining", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);
    harness.setResourceAdmissionPaused(true);
    await harness.closeAdmission();

    const connection = await harness.admit("resource-before-draining");

    await expect(connection.terminal).resolves.toMatchObject({
      kind: "rejected",
      code: "resource-pressure",
    });
    expect(harness.acceptedRequestCount()).toBe(0);
  });

  it("checks queue draining before conflicting duplicate payloads", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);
    const accepted = await harness.admit("draining-before-conflict", ["overview", "input.ts"]);
    await executor.started(1);
    const drained = harness.closeAdmission();

    const connection = await harness.admit("draining-before-conflict", ["overview", "other.ts"]);

    await expect(connection.terminal).resolves.toMatchObject({
      kind: "rejected",
      code: "draining",
    });
    expect(harness.acceptedRequestCount()).toBe(1);
    executor.complete(0);
    await accepted.terminal;
    await drained;
  });

  it("starts admission resource sampling without awaiting it", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);
    const sample = harness.blockAdmissionSample();

    const connection = await Promise.race([
      harness.admit("nonawaited-sample"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Admission waited for resource sampling")), 50),
      ),
    ]);

    expect(sample).toHaveBeenCalledWith("admission");
    expect(connection.frames[0]).toEqual(
      expect.objectContaining({ kind: "accepted", requestId: "nonawaited-sample" }),
    );
    await expect(connection.terminal).resolves.toMatchObject({
      kind: "result-end",
      requestId: "nonawaited-sample",
    });
  });

  it("rejects the prior execute-envelope generation before command execution", async () => {
    const executor = new RecordingExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);

    await expect(harness.executeAtProtocol("prior-generation", 4)).rejects.toThrow("protocol");
    expect(executor.requests).toEqual([]);
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

  it("keeps the latest duplicate result delivery as the process queue barrier", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);
    const firstResultEnd = harness.transport.stallNextResultEnd();
    const first = await harness.admit("duplicate-barrier");
    await executor.started(1);
    const secondResultEnd = harness.transport.stallNextResultEnd();
    const duplicate = await harness.admit("duplicate-barrier");
    const following = harness.execute("after-duplicate-barrier");

    executor.complete(0);
    await Promise.all([firstResultEnd.started, secondResultEnd.started]);
    firstResultEnd.release();
    await first.terminal;
    await new Promise((resolve) => setImmediate(resolve));

    expect(executor.startedCount).toBe(1);
    expect(duplicate.frames.some((frame) => "kind" in frame && frame.kind === "result-end")).toBe(
      false,
    );

    secondResultEnd.release();
    await duplicate.terminal;
    await executor.started(2);
    executor.complete(1);
    await following;
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

  it("preserves capacity classification for a derived capacity error", async () => {
    const harness = await RequestHarness.start(new MultipleRecordExecutor(), {
      completionSpoolLimits: { inlineBytes: 5, maximumResultBytes: 100 },
      completionSpoolStorage: new DerivedCapacityCompletionStorage(),
    });
    harnesses.push(harness);

    await expect(harness.execute("derived-capacity")).resolves.toMatchObject({
      kind: "execution-failed",
      code: "response-capacity",
    });
  });

  it("preserves worker-exit classification for a derived worker error", async () => {
    const error = new DerivedNavigationWorkerExitedError({
      generation: 1,
      cause: "error",
    });
    const harness = await RequestHarness.start(undefined, {
      navigationWorker: new ExecutionFailingNavigationWorker(error),
    });
    harnesses.push(harness);

    await expect(harness.execute("derived-worker-exit")).resolves.toMatchObject({
      kind: "execution-failed",
      code: "worker-exit",
    });
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
    const first = harness.execute("first", ["--cwd", "/repo", "overview", "input"], "refs");
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
    expect(executor.requests[0]?.argv).toEqual(["--cwd", "/repo", "overview", "input"]);
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
    await harness.exited;
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "shutdown", reason: "graceful", force: false }),
      ]),
    );
  });

  it("cleans instance spools only after graceful worker shutdown completes", async () => {
    const transitions: string[] = [];
    const worker = new ShutdownGatedNavigationWorker(new ImmediateExecutor(), transitions);
    const storage = new ObservingInstanceCleanupStorage(transitions);
    const harness = await RequestHarness.start(undefined, {
      navigationWorker: worker,
      completionSpoolStorage: storage,
    });
    harnesses.push(harness);

    await harness.stop();
    await worker.closeStarted;
    const transitionsWhileWorkerWasBlocked = [...transitions];
    worker.allowClose();
    await harness.exited;

    expect(transitionsWhileWorkerWasBlocked).toEqual(["worker-close-started"]);
    expect(transitions).toEqual([
      "worker-close-started",
      "worker-close-completed",
      "instance-spool-cleanup",
    ]);
  });

  it("reports draining from the main thread while admitted work completes", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);
    const execution = harness.execute("draining", ["graph", "input"]);
    await executor.started(1);

    const stopping = harness.stop();
    const draining = await harness.ping();
    expect(draining).toMatchObject({
      kind: "pong",
      activity: { lifecycle: "draining" },
    });
    expect(draining.kind === "pong" ? draining.activity?.current : undefined).toBeUndefined();

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

    await waitUntil(() => harness.logEvents().some((event) => event.kind === "worker-completed"));
    expect(
      harness
        .logEvents()
        .filter((event) => event.kind === "freshness" || event.kind === "worker-completed"),
    ).toHaveLength(2);
  });

  it("records ordered execution and delivery terminals for one request", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    await harness.execute("observed", ["refs", "private-symbol"]);
    await waitUntil(() => harness.logEvents().some((event) => event.kind === "delivery-terminal"));

    const operationDiagnostics = harness
      .logEvents()
      .filter((event) => typeof event.requestId === "string");
    const operationEvents = operationDiagnostics.map((event) => event.kind);
    expect(operationEvents).toEqual([
      "request-accepted",
      "turn-started",
      "worker-completed",
      "response-spooled",
      "execution-terminal",
      "delivery-terminal",
    ]);
    const requestCorrelations = [...new Set(operationDiagnostics.map((event) => event.requestId))];
    expect(requestCorrelations).toHaveLength(1);
    expect(requestCorrelations[0]).toMatch(/^[a-f\d]{64}$/);
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "execution-terminal",
          requestId: expect.stringMatching(/^[a-f\d]{64}$/),
          outcome: "completed",
          serviceMs: expect.any(Number),
          processRssBytes: expect.any(Number),
        }),
        expect.objectContaining({
          kind: "delivery-terminal",
          requestId: expect.stringMatching(/^[a-f\d]{64}$/),
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

  it("releases successful request traces after acknowledgement under sustained churn", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);

    for (let index = 0; index < 100; index += 1) {
      const requestId = `completed-${index}`;
      const completed = await harness.execute(requestId);
      if (completed.kind !== "result-end") throw new Error("Expected completed result");
      await harness.acknowledge(requestId, completed.transferId);
    }

    expect(harness.retainedOperationTraceCount()).toBe(0);
  });

  it("releases non-replayable failed request traces after delivery", async () => {
    const harness = await RequestHarness.start(new RejectingExecutor());
    harnesses.push(harness);

    await expect(harness.execute("failed-trace")).resolves.toMatchObject({
      kind: "execution-failed",
      code: "internal",
    });

    expect(harness.retainedOperationTraceCount()).toBe(0);
    await waitUntil(() => harness.logEvents().some((event) => event.kind === "delivery-terminal"));
    expect(harness.logEvents().filter((event) => event.kind === "execution-terminal")).toHaveLength(
      1,
    );
    expect(harness.logEvents().filter((event) => event.kind === "delivery-terminal")).toHaveLength(
      1,
    );
  });

  it("retains disconnected request traces only until replay acknowledgement", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);
    const disconnected = await harness.admit("reattached-trace", ["overview", "input.ts"]);
    await executor.started(1);
    disconnected.disconnect();
    executor.complete(0);
    await waitUntil(
      async () => (await harness.status("reattached-trace")).status.state === "completed",
    );

    expect(harness.retainedOperationTraceCount()).toBe(1);
    const reattached = await harness.admit("reattached-trace", ["overview", "input.ts"]);
    const completed = await reattached.terminal;
    if (completed.kind !== "result-end") throw new Error("Expected completed result");
    await harness.acknowledge("reattached-trace", completed.transferId);

    expect(harness.retainedOperationTraceCount()).toBe(0);
    await waitUntil(() => harness.logEvents().some((event) => event.kind === "delivery-terminal"));
    const terminalEvents = harness
      .logEvents()
      .filter((event) => event.kind === "delivery-terminal");
    expect(terminalEvents).toHaveLength(1);
    expect(
      harness.logEvents().filter((event) => event.kind === "client-disconnected"),
    ).toHaveLength(1);
    expect(harness.logEvents().filter((event) => event.kind === "client-reattached")).toHaveLength(
      1,
    );
  });

  it("records result-fetch as reattachment without replaying execution", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor);
    harnesses.push(harness);
    const disconnected = await harness.admit("fetched-trace", ["overview", "input.ts"]);
    await executor.started(1);
    disconnected.disconnect();
    executor.complete(0);
    await waitUntil(
      async () => (await harness.status("fetched-trace")).status.state === "completed",
    );

    const resumed = await harness.fetch("fetched-trace");
    const completed = await resumed.terminal;
    if (completed.kind !== "result-end") throw new Error("Expected completed result");
    await harness.acknowledge("fetched-trace", completed.transferId);

    expect(executor.requests).toHaveLength(1);
    await waitUntil(() => harness.logEvents().some((event) => event.kind === "client-reattached"));
    expect(harness.logEvents().filter((event) => event.kind === "client-reattached")).toHaveLength(
      1,
    );
  });

  it("keeps a delivered trace while a result-fetch caller remains connected", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor, { operationTraceRetentionMs: 20 });
    harnesses.push(harness);
    const initial = await harness.admit("delivered-refetch", ["overview", "input.ts"]);
    await executor.started(1);
    executor.complete(0);
    const initialCompletion = await initial.terminal;
    if (initialCompletion.kind !== "result-end") throw new Error("Expected completed result");
    initial.disconnect();
    await waitUntil(
      () =>
        harness.logEvents().filter((event) => event.kind === "client-disconnected").length === 1,
    );

    const refetched = await harness.fetch("delivered-refetch");
    const refetchedCompletion = await refetched.terminal;
    if (refetchedCompletion.kind !== "result-end") throw new Error("Expected completed result");
    expect(refetchedCompletion.transferId).toBe(initialCompletion.transferId);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.retainedOperationTraceCount()).toBe(1);
    expect(
      harness.logEvents().filter((event) => event.kind === "operation-trace-expired"),
    ).toHaveLength(0);

    refetched.disconnect();
    await waitUntil(
      () =>
        harness.retainedOperationTraceCount() === 0 &&
        harness.logEvents().filter((event) => event.kind === "operation-trace-expired").length ===
          1,
    );
    const resumed = await harness.fetch("delivered-refetch");
    const resumedCompletion = await resumed.terminal;
    if (resumedCompletion.kind !== "result-end") throw new Error("Expected completed result");
    expect(resumedCompletion.transferId).toBe(initialCompletion.transferId);
    await harness.acknowledge("delivered-refetch", initialCompletion.transferId);

    expect(executor.requests).toHaveLength(1);
    expect(harness.logEvents().filter((event) => event.kind === "delivery-terminal")).toHaveLength(
      1,
    );
  });

  it("expires disconnected traces without expiring resumable results", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor, { operationTraceRetentionMs: 10 });
    harnesses.push(harness);
    const disconnected = await harness.admit("expired-trace", ["overview", "input.ts"]);
    await executor.started(1);
    disconnected.disconnect();
    executor.complete(0);
    await waitUntil(
      async () => (await harness.status("expired-trace")).status.state === "completed",
    );
    await waitUntil(() => harness.retainedOperationTraceCount() === 0);

    const resumed = await harness.fetch("expired-trace");
    const completed = await resumed.terminal;
    if (completed.kind !== "result-end") throw new Error("Expected completed result");
    const retried = await harness.fetch("expired-trace");
    const retriedCompletion = await retried.terminal;
    if (retriedCompletion.kind !== "result-end") throw new Error("Expected completed result");
    expect(retriedCompletion.transferId).toBe(completed.transferId);
    await harness.acknowledge("expired-trace", completed.transferId);

    expect(executor.requests).toHaveLength(1);
    await waitUntil(
      () =>
        harness.logEvents().filter((event) => event.kind === "client-reattached").length === 1 &&
        harness.logEvents().filter((event) => event.kind === "delivery-terminal").length === 1,
    );
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "operation-trace-expired" }),
        expect.objectContaining({ kind: "client-reattached" }),
        expect.objectContaining({ kind: "delivery-terminal", outcome: "delivered" }),
      ]),
    );
    expect(harness.logEvents().filter((event) => event.kind === "delivery-terminal")).toHaveLength(
      1,
    );
    expect(harness.logEvents().filter((event) => event.kind === "client-reattached")).toHaveLength(
      1,
    );
  });

  it("bounds retained traces during sustained abandoned disconnect churn", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor, {
      operationTraceRetentionMs: 10_000,
      maximumRetainedOperationTraces: 3,
    });
    harnesses.push(harness);

    for (let index = 0; index < 10; index += 1) {
      const requestId = `abandoned-${index}`;
      const disconnected = await harness.admit(requestId, ["overview", "input.ts"]);
      await executor.started(index + 1);
      disconnected.disconnect();
      executor.complete(index);
      await waitUntil(async () => (await harness.status(requestId)).status.state === "completed");
      await waitUntil(
        () =>
          harness.logEvents().filter((event) => event.kind === "client-disconnected").length ===
          index + 1,
      );
    }

    expect(harness.retainedOperationTraceCount()).toBe(3);
    await waitUntil(
      () =>
        harness.logEvents().filter((event) => event.kind === "operation-trace-expired").length ===
        7,
    );
    expect(
      harness.logEvents().filter((event) => event.kind === "operation-trace-expired"),
    ).toHaveLength(7);
  });

  it("severs evicted and expired traces while blocked requests remain resumable", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor, {
      operationTraceRetentionMs: 20,
      maximumRetainedOperationTraces: 1,
    });
    harnesses.push(harness);
    const active = await harness.admit("evicted-active", ["overview", "active.ts"]);
    await executor.started(1);
    const queued = await harness.admit("expired-queued", ["overview", "queued.ts"]);
    active.disconnect();
    queued.disconnect();

    await waitUntil(
      () =>
        harness.retainedOperationTraceCount() === 0 &&
        harness.logEvents().filter((event) => event.kind === "operation-trace-expired").length ===
          2,
    );
    executor.complete(0);
    await executor.started(2);
    executor.complete(1);
    await waitUntil(
      async () => (await harness.status("expired-queued")).status.state === "completed",
    );

    expect(
      harness
        .logEvents()
        .filter((event) =>
          ["worker-completed", "response-spooled", "execution-terminal"].includes(
            String(event.kind),
          ),
        ),
    ).toHaveLength(0);

    for (const requestId of ["evicted-active", "expired-queued"]) {
      const resumed = await harness.fetch(requestId);
      const completed = await resumed.terminal;
      if (completed.kind !== "result-end") throw new Error("Expected completed result");
      await harness.acknowledge(requestId, completed.transferId);
    }
    await waitUntil(
      () => harness.logEvents().filter((event) => event.kind === "delivery-terminal").length === 2,
    );
    expect(executor.requests).toHaveLength(2);
    expect(harness.logEvents().filter((event) => event.kind === "client-reattached")).toHaveLength(
      2,
    );
  });

  it("expires a blocked trace after its reattached caller disconnects", async () => {
    const executor = new SerializedExecutor();
    const harness = await RequestHarness.start(executor, {
      operationTraceRetentionMs: 20,
    });
    harnesses.push(harness);
    const initial = await harness.admit("reattached-active", ["overview", "input.ts"]);
    await executor.started(1);
    initial.disconnect();

    const firstReattached = await harness.admit("reattached-active", ["overview", "input.ts"]);
    const secondReattached = await harness.admit("reattached-active", ["overview", "input.ts"]);
    firstReattached.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.retainedOperationTraceCount()).toBe(1);
    secondReattached.disconnect();

    await waitUntil(
      () =>
        harness.retainedOperationTraceCount() === 0 &&
        harness.logEvents().filter((event) => event.kind === "operation-trace-expired").length ===
          1,
    );
    executor.complete(0);
    await waitUntil(
      async () => (await harness.status("reattached-active")).status.state === "completed",
    );

    const resumed = await harness.fetch("reattached-active");
    const completed = await resumed.terminal;
    if (completed.kind !== "result-end") throw new Error("Expected completed result");
    await harness.acknowledge("reattached-active", completed.transferId);

    expect(executor.requests).toHaveLength(1);
    expect(
      harness.logEvents().filter((event) => event.kind === "client-disconnected"),
    ).toHaveLength(2);
    expect(harness.logEvents().filter((event) => event.kind === "client-reattached")).toHaveLength(
      1,
    );
  });

  it("releases retained request traces during shutdown", async () => {
    const harness = await RequestHarness.start(new ImmediateExecutor());
    harnesses.push(harness);
    await harness.execute("shutdown-trace");
    expect(harness.retainedOperationTraceCount()).toBe(1);

    await harness.kill();
    await harness.exited;

    expect(harness.retainedOperationTraceCount()).toBe(0);
    expect(harness.logEvents().filter((event) => event.kind === "delivery-terminal")).toHaveLength(
      1,
    );
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
    await waitUntil(() => harness.logEvents().some((event) => event.kind === "worker-replaced"));
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "worker-replaced",
          cause: "out-of-memory",
          previousWorkerGeneration: 1,
          workerGeneration: 2,
          fileCount: 1,
        }),
      ]),
    );
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

  it("classifies a literal active worker exit without replaying the request", async () => {
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
    const active = harness.execute("worker-exit-active", ["refs", "input"]);
    await activeExecutor.started(1);
    const queued = harness.execute("worker-exit-queued", ["overview", "input.ts"]);

    workers[0]?.fail({ generation: 1, cause: "error", errorName: "WorkerCrash" });

    await expect(active).resolves.toMatchObject({
      kind: "execution-failed",
      requestId: "worker-exit-active",
      code: "worker-exit",
    });
    await expect(queued).resolves.toMatchObject({
      kind: "result-end",
      requestId: "worker-exit-queued",
    });
    expect(activeExecutor.requests).toHaveLength(1);
    expect(replacementExecutor.requests).toHaveLength(1);
  });

  it("reports worker replacement recovery from the main thread", async () => {
    const initial = new ExecutorNavigationWorker(new ImmediateExecutor(), 1);
    const replacement = new DeferredInitializationWorker(2);
    const harness = await RequestHarness.start(undefined, {
      navigationWorkerFactory: (generation) => (generation === 1 ? initial : replacement),
    });
    harnesses.push(harness);

    initial.fail({ generation: 1, cause: "out-of-memory", errorName: "WorkerOom" });
    await replacement.initializationStarted;

    const recovering = await harness.ping();
    expect(recovering).toMatchObject({
      kind: "pong",
      fileCount: 1,
      activity: {
        lifecycle: "recovering",
        recoveryDetail: "worker-replacement",
        workerGeneration: 2,
      },
    });
    expect(recovering.kind === "pong" ? recovering.activity : undefined).not.toHaveProperty(
      "fileCount",
    );

    replacement.completeInitialization();
    await waitUntil(async () => {
      const pong = await harness.ping();
      return pong.kind === "pong" && pong.state === "ready";
    });
  });

  it("starts the next generation before terminating the previous worker", async () => {
    const transitions: string[] = [];
    const initial = new OrderedInitializationWorker(1, transitions, true);
    const replacement = new OrderedInitializationWorker(2, transitions, false);
    const harness = await RequestHarness.start(undefined, {
      navigationWorkerFactory: (generation) => (generation === 1 ? initial : replacement),
    });
    harnesses.push(harness);
    transitions.length = 0;

    initial.fail({ generation: 1, cause: "out-of-memory", errorName: "WorkerOom" });
    await replacement.initializationStarted;

    expect(transitions).toEqual(["start:2", "terminate:1"]);
    await expect(harness.ping()).resolves.toMatchObject({
      kind: "pong",
      activity: {
        lifecycle: "recovering",
        recoveryDetail: "worker-replacement",
        workerGeneration: 2,
      },
    });

    replacement.completeInitialization();
    await waitUntil(async () => {
      const pong = await harness.ping();
      return pong.kind === "pong" && pong.state === "ready";
    });
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
      activity: {
        lifecycle: "recovering",
        recoveryDetail: "resource-pressure",
        queued: 1,
      },
    });

    worker.allowRelease();
    await executor.started(2);
    executor.complete(1);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: "result-end", requestId: "first" }),
      expect.objectContaining({ kind: "result-end", requestId: "second" }),
    ]);
    expect(worker.releaseCount).toBe(1);
    await waitUntil(() => harness.logEvents().some((event) => event.kind === "resources-released"));
    expect(harness.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "resources-released",
          workerGeneration: 1,
          workerHeapUsedBytes: 1,
          workerHeapLimitBytes: 2,
        }),
      ]),
    );
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
      residentMemoryBytes: () => 0,
      navigationWorkerFactory: (generation) => {
        generations.push(generation);
        return new NodeDaemonNavigationWorker({
          generation,
          configuration: {
            stateDirectory: "/state",
            productVersion: "test",
            executorModuleUrl: "file:///test/daemon-executor.js",
            policy: DaemonPolicyCodec.serialize(DaemonPolicy.currentSystem()),
          },
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
    const warming = await harness.ping();
    const admission = await harness.admit("before-warmup-completes");
    const rejection = await admission.terminal;
    worker.allowRelease();
    await starting;
    lease.release();

    expect(warming).toMatchObject({
      kind: "pong",
      fileCount: 1,
      activity: {
        lifecycle: "recovering",
        recoveryDetail: "resource-pressure",
        workerGeneration: 1,
      },
    });
    expect
      .soft(warming.kind === "pong" ? warming.activity : undefined)
      .not.toHaveProperty("fileCount");
    expect.soft(rejection).toMatchObject({
      kind: "rejected",
      code: "not-ready",
    });
    expect(harness.acceptedRequestCount()).toBe(0);

    await expect(harness.ping()).resolves.toMatchObject({ state: "ready" });
  });

  it("recovers a real old-generation exhaustion without replaying active work", async () => {
    const harness = await RequestHarness.start(undefined, {
      residentMemoryBytes: () => 0,
      navigationWorkerFactory: (generation) =>
        new NodeDaemonNavigationWorker({
          generation,
          configuration: {
            stateDirectory: "/state",
            productVersion: "test",
            executorModuleUrl: "file:///test/daemon-executor.js",
            policy: DaemonPolicyCodec.serialize(DaemonPolicy.currentSystem()),
          },
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
    const residentMemoryBaselineBytes = process.memoryUsage().rss;
    const harness = await RequestHarness.start(undefined, {
      resourcePolicy: policy,
      resourceCheckIntervalMs: 25,
      residentMemoryBytes: () =>
        policy.record.resumeProcessRssBytes -
        1 +
        Math.max(0, process.memoryUsage().rss - residentMemoryBaselineBytes),
      navigationWorkerFactory: (generation) =>
        new NodeDaemonNavigationWorker({
          generation,
          configuration: {
            stateDirectory: "/state",
            productVersion: "test",
            executorModuleUrl: "file:///test/daemon-executor.js",
            policy: DaemonPolicyCodec.serialize(DaemonPolicy.currentSystem()),
          },
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
  private daemon: DaemonProcessCoordinator | undefined;
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
    readonly daemon: DaemonProcessCoordinator;
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
    const daemonPolicy = DaemonPolicy.currentSystem();
    const daemon = new DaemonProcessCoordinator({
      identity: harness.identity,
      instanceId: harness.instanceId,
      processToken: harness.processToken,
      symnavVersion: "test",
      memoryCapBytes: 1024,
      policy: daemonPolicy,
      registry: harness.registry,
      transport: harness.transport satisfies DaemonRequestServer,
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
      ...(options.operationTraceRetentionMs === undefined
        ? {}
        : { operationTraceRetentionMs: options.operationTraceRetentionMs }),
      ...(options.maximumRetainedOperationTraces === undefined
        ? {}
        : { maximumRetainedOperationTraces: options.maximumRetainedOperationTraces }),
      ...(options.resourcePolicy === undefined ? {} : { resourcePolicy: options.resourcePolicy }),
      ...(options.resourceCheckIntervalMs === undefined
        ? {}
        : { resourceCheckIntervalMs: options.resourceCheckIntervalMs }),
      ...(options.residentMemoryBytes === undefined
        ? {}
        : { residentMemoryBytes: options.residentMemoryBytes }),
      exit: (code) => harness.resolveExit(code),
    });
    harness.daemon = daemon;
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

  execute(
    requestId: string,
    argv: readonly string[] = ["--version"],
    commandName: DaemonCommandName = this.commandName(argv),
  ): Promise<DaemonResponse> {
    return this.admit(requestId, argv, commandName).then((connection) => connection.terminal);
  }

  executeAtProtocol(requestId: string, protocolVersion: number): Promise<DaemonResponse> {
    return this.transport
      .connect({
        kind: "execute",
        protocolVersion,
        instanceId: this.instanceId,
        processToken: this.processToken,
        requestId,
        commandName: "version",
        request: {
          argv: ["--version"],
          cwd: this.workspaceRoot,
          telemetryEnabled: false,
          executionMode: "warm",
        },
      })
      .then((connection) => connection.terminal);
  }

  admit(
    requestId: string,
    argv: readonly string[] = ["--version"],
    commandName: DaemonCommandName = this.commandName(argv),
  ): Promise<RequestConnection> {
    return this.transport.connect({
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      processToken: this.processToken,
      requestId,
      commandName,
      request: { argv, cwd: this.workspaceRoot, telemetryEnabled: false, executionMode: "warm" },
    });
  }

  admitWithToken(requestId: string, processToken: string): Promise<RequestConnection> {
    return this.transport.connect({
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      processToken,
      requestId,
      commandName: "version",
      request: {
        argv: ["--version"],
        cwd: this.workspaceRoot,
        telemetryEnabled: false,
        executionMode: "warm",
      },
    });
  }

  acceptedRequestCount(): number {
    const session = this.daemonInternals.acceptedExecutionSession as unknown as {
      readonly options: { readonly ledger: AcceptedRequestLedger };
    };
    return session.options.ledger.size;
  }

  setWorkerReady(workerReady: boolean): void {
    const workerManager = this.daemonInternals.workerManager;
    const snapshot = workerManager.snapshot;
    vi.spyOn(workerManager, "snapshot", "get").mockReturnValue({ ...snapshot, ready: workerReady });
  }

  setResourceAdmissionPaused(admissionPaused: boolean): void {
    const resourceSupervisor = this.daemonInternals.resourceSupervisor;
    const snapshot = resourceSupervisor.snapshot;
    vi.spyOn(resourceSupervisor, "snapshot", "get").mockReturnValue({
      ...snapshot,
      admissionPaused,
    });
  }

  closeAdmission(): Promise<void> {
    return this.daemonInternals.acceptedExecutionSession.drain();
  }

  observeAdmissionSamples(): ReturnType<typeof vi.fn> {
    const resourceSupervisor = this.daemonInternals.resourceSupervisor;
    const sample = vi.fn(resourceSupervisor.sample.bind(resourceSupervisor));
    resourceSupervisor.sample = sample;
    return sample;
  }

  blockAdmissionSample(): ReturnType<typeof vi.fn> {
    const resourceSupervisor = this.daemonInternals.resourceSupervisor;
    const originalSample = resourceSupervisor.sample.bind(resourceSupervisor);
    const sample = vi.fn((reason: "warmup" | "interval" | "admission" | "turn-complete") =>
      reason === "admission" ? new Promise<void>(() => {}) : originalSample(reason),
    );
    resourceSupervisor.sample = sample;
    return sample;
  }

  private get daemonInternals(): {
    readonly acceptedExecutionSession: AcceptedExecutionSession;
    readonly workerManager: DaemonWorkerGenerationManager;
    readonly resourceSupervisor: DaemonResourceSupervisor & {
      readonly snapshot: DaemonResourceSnapshot;
    };
  } {
    if (this.daemon === undefined) throw new Error("Workspace daemon is unavailable");
    return this.daemon as unknown as {
      readonly acceptedExecutionSession: AcceptedExecutionSession;
      readonly workerManager: DaemonWorkerGenerationManager;
      readonly resourceSupervisor: DaemonResourceSupervisor & {
        readonly snapshot: DaemonResourceSnapshot;
      };
    };
  }

  private commandName(argv: readonly string[]): DaemonCommandName {
    const commandName = argv.find((argument): argument is DaemonCommandName =>
      DAEMON_COMMAND_NAMES.includes(argument as DaemonCommandName),
    );
    return commandName ?? "version";
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

  fetch(requestId: string, offset = 0): Promise<RequestConnection> {
    return this.transport.connect({
      kind: "result-fetch",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      processToken: this.processToken,
      requestId,
      offset,
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

  retainedOperationTraceCount(): number {
    const daemon = this.daemon as unknown as {
      readonly deliverySession: {
        readonly operationTraces: ReadonlyMap<string, unknown>;
      };
    };
    return daemon.deliverySession.operationTraces.size;
  }

  async dispose(): Promise<void> {
    if (this.transport.isListening) {
      await this.transport
        .receive({ kind: "kill", instanceId: this.instanceId, processToken: this.processToken })
        .catch(() => undefined);
      await this.waitForExit();
    }
    rmSync(this.stateDirectory, { recursive: true, force: true });
    rmSync(this.workspaceRoot, { recursive: true, force: true });
  }

  private waitForExit(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for request harness shutdown")),
        5_000,
      );
      void this.exited.then(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
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
  readonly completionSpoolLimits?: DaemonProcessCoordinatorOptions["completionSpoolLimits"];
  readonly completionSpoolStorage?: DaemonProcessCoordinatorOptions["completionSpoolStorage"];
  readonly operationTraceRetentionMs?: number;
  readonly maximumRetainedOperationTraces?: number;
}

class RequestTransport {
  private handler:
    | ((request: DaemonRequest, send: DaemonServerSend) => Promise<DaemonResponse | void>)
    | undefined;
  listenError: Error | undefined;
  closeError: Error | undefined;
  readonly sentFrames: DaemonServerMessage[] = [];
  private resultChunkGate:
    | {
        readonly started: () => void;
        readonly wait: Promise<void>;
      }
    | undefined;
  private resultChunksInFlight = 0;
  private maximumResultChunksInFlight = 0;
  private readonly resultEndGates: {
    readonly started: () => void;
    readonly wait: Promise<void>;
  }[] = [];

  get isListening(): boolean {
    return this.handler !== undefined;
  }

  removeUnavailableEndpoint(): Promise<boolean> {
    return Promise.resolve(false);
  }

  async listen(
    _endpoint: string,
    handler: (request: DaemonRequest, send: DaemonServerSend) => Promise<DaemonResponse | void>,
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
    const send: DaemonServerSend = Object.assign(async () => undefined, {
      onClose: () => () => undefined,
    });
    const response = await this.handler(request, send);
    if (response === undefined) throw new Error("Transport handler returned no response");
    return response;
  }

  async connect(request: DaemonRequest): Promise<RequestConnection> {
    if (this.handler === undefined) throw new Error("Transport is not listening");
    const resultEndGate = this.resultEndGates.shift();
    const frames: DaemonServerMessage[] = [];
    let connected = true;
    const closeListeners = new Set<() => void>();
    let resolveTerminal!: (frame: DaemonExecutionServerFrame) => void;
    const terminal = new Promise<DaemonExecutionServerFrame>((resolve) => {
      resolveTerminal = resolve;
    });
    const receive = async (response: DaemonServerMessage): Promise<void> => {
      this.sentFrames.push(response);
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
      if ("kind" in response && response.kind === "result-end" && resultEndGate !== undefined) {
        resultEndGate.started();
        await resultEndGate.wait;
      }
      if (!connected) throw new Error("Request connection is closed");
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
    const send = Object.assign(receive, {
      onClose: (listener: () => void): (() => void) => {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
    });
    const response = await this.handler(request, send);
    if (response !== undefined) await receive(response);
    return {
      frames,
      terminal,
      disconnect: () => {
        connected = false;
        for (const listener of closeListeners) listener();
        closeListeners.clear();
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

  stallNextResultEnd(): {
    readonly started: Promise<void>;
    readonly release: () => void;
  } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.resultEndGates.push({ started: markStarted, wait });
    return { started, release };
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
      this.executionCount === 1
        ? [
            { stream: "stdout" as const, bytes: Buffer.from("x") },
            { stream: "stdout" as const, bytes: Buffer.from("x") },
          ]
        : [];
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

class DerivedCompletionSpoolCapacityError extends CompletionSpoolCapacityError {}

class DerivedCapacityCompletionStorage extends NodeCompletionSpoolStorage {
  override async createFile(path: string): Promise<CompletionSpoolFile> {
    const file = await super.createFile(path);
    return {
      write: (bytes) => file.write(bytes),
      sync: () => Promise.reject(new DerivedCompletionSpoolCapacityError()),
      close: () => file.close(),
    };
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

  override async *records(
    path: string,
    maximumChunkBytes: number,
  ): AsyncIterable<CommandOutputRecord> {
    if (this.fail("read")) throw new Error("read failed");
    for await (const record of super.records(path, maximumChunkBytes)) yield record;
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

class ObservingInstanceCleanupStorage extends NodeCompletionSpoolStorage {
  constructor(private readonly transitions: string[]) {
    super();
  }

  override async removeInstance(path: string): Promise<void> {
    this.transitions.push("instance-spool-cleanup");
    await super.removeInstance(path);
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
    _commandName: DaemonCommandName,
    request: CliExecutionRequest,
    output: Parameters<DaemonNavigationWorker["execute"]>[3],
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
      resources: {
        workerHeapUsedBytes: 1,
        peakWorkerHeapUsedBytes: 1,
        workerHeapLimitBytes: 2,
      },
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
    this.rejectTermination(new DaemonNavigationWorkerExitedError(exit));
    this.resolveExited(exit);
  }
}

class ShutdownGatedNavigationWorker extends ExecutorNavigationWorker {
  readonly closeStarted: Promise<void>;
  private resolveCloseStarted!: () => void;
  private allowCloseResolution!: () => void;
  private readonly closeAllowed: Promise<void>;

  constructor(
    executor: DaemonCommandExecutor,
    private readonly transitions: string[],
  ) {
    super(executor);
    this.closeStarted = new Promise((resolve) => {
      this.resolveCloseStarted = resolve;
    });
    this.closeAllowed = new Promise((resolve) => {
      this.allowCloseResolution = resolve;
    });
  }

  override async drainAndClose(): Promise<void> {
    this.transitions.push("worker-close-started");
    this.resolveCloseStarted();
    await this.closeAllowed;
    this.transitions.push("worker-close-completed");
    await super.drainAndClose();
  }

  allowClose(): void {
    this.allowCloseResolution();
  }
}

class DerivedNavigationWorkerExitedError extends DaemonNavigationWorkerExitedError {}

class ExecutionFailingNavigationWorker extends ExecutorNavigationWorker {
  constructor(private readonly error: Error) {
    super(new ImmediateExecutor());
  }

  override execute(): Promise<DaemonNavigationWorkerResponse> {
    return Promise.reject(this.error);
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
  readonly generation: number;
  readonly exited = new Promise<DaemonNavigationWorkerExit>(() => undefined);
  readonly initializationStarted: Promise<void>;
  private resolveInitializationStarted!: () => void;
  private resolveReady!: (response: DaemonNavigationWorkerResponse) => void;
  private readonly ready: Promise<DaemonNavigationWorkerResponse>;

  constructor(generation = 1) {
    this.generation = generation;
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

class OrderedInitializationWorker implements DaemonNavigationWorker {
  readonly exited: Promise<DaemonNavigationWorkerExit>;
  readonly initializationStarted: Promise<void>;
  private resolveExited!: (exit: DaemonNavigationWorkerExit) => void;
  private resolveInitializationStarted!: () => void;
  private resolveReady!: (response: DaemonNavigationWorkerResponse) => void;
  private readonly ready: Promise<DaemonNavigationWorkerResponse>;

  constructor(
    readonly generation: number,
    private readonly transitions: string[],
    readyImmediately: boolean,
  ) {
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.initializationStarted = new Promise((resolve) => {
      this.resolveInitializationStarted = resolve;
    });
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    if (readyImmediately) this.completeInitialization();
  }

  start(): Promise<DaemonNavigationWorkerResponse> {
    this.transitions.push(`start:${this.generation}`);
    this.resolveInitializationStarted();
    return this.ready;
  }

  execute(): Promise<DaemonNavigationWorkerResponse> {
    throw new Error("Ordered initialization worker is not executable");
  }

  releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    throw new Error("Ordered initialization worker has no transient resources");
  }

  drainAndClose(): Promise<void> {
    return Promise.resolve();
  }

  terminate(): Promise<void> {
    this.transitions.push(`terminate:${this.generation}`);
    return Promise.resolve();
  }

  fail(exit: DaemonNavigationWorkerExit): void {
    this.resolveExited(exit);
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
