import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import { DaemonResourceSupervisor } from "./daemon-resource-monitor.js";
import type { DaemonWorkerExitRecovery } from "./daemon-worker-generation-manager.js";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

describe("DaemonResourceSupervisor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("samples every 250 milliseconds without blocking the timer owner", async () => {
    const policy = resourcePolicy();
    const residentMemoryBytes = vi.fn(() => 0);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes,
      spoolBytes: () => 0,
      scheduleAtTurnBoundary: runImmediately,
      releaseTransientResources: async () => undefined,
      replaceWorker: async () => 2,
      drain: async () => undefined,
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(249);
    expect(residentMemoryBytes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(residentMemoryBytes).toHaveBeenCalledOnce();
    supervisor.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(residentMemoryBytes).toHaveBeenCalledOnce();
  });

  it("uses the required resource-policy cadence and thresholds", async () => {
    const policy = DaemonPolicyTestFactory.withOverrides(
      DaemonPolicy.fromSystemMemory({ totalBytes: GIBIBYTE }),
      {
        resources: {
          supervisionIntervalMs: 17,
          hardProcessRssBytes: 103,
          softProcessRssBytes: 102,
          resumeProcessRssBytes: 101,
        },
      },
    );
    let residentMemoryBytes = 102;
    const releaseTransientResources = vi.fn(async () => undefined);
    const supervisor = new DaemonResourceSupervisor({
      policy: policy.values.resources,
      generation: 1,
      residentMemoryBytes: () => residentMemoryBytes,
      spoolBytes: () => 0,
      scheduleAtTurnBoundary: runImmediately,
      releaseTransientResources,
      replaceWorker: async () => 2,
      drain: async () => undefined,
    } as unknown as ConstructorParameters<typeof DaemonResourceSupervisor>[0]);

    supervisor.start();
    await vi.advanceTimersByTimeAsync(16);
    expect(releaseTransientResources).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(releaseTransientResources).toHaveBeenCalledOnce();
    residentMemoryBytes = 100;
    await supervisor.sample("interval");
    expect(supervisor.snapshot.admissionPaused).toBe(false);
    supervisor.stop();
  });

  it("pauses admission and sheds once per soft-pressure hysteresis cycle", async () => {
    const policy = resourcePolicy();
    let residentMemoryBytes = policy.softProcessRssBytes + 1;
    const releaseTransientResources = vi.fn(async () => undefined);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => residentMemoryBytes,
      spoolBytes: () => 0,
      scheduleAtTurnBoundary: runImmediately,
      releaseTransientResources,
      replaceWorker: async () => 2,
      drain: async () => undefined,
    });

    await supervisor.sample("admission");
    await supervisor.sample("interval");
    expect(supervisor.snapshot.admissionPaused).toBe(true);
    expect(releaseTransientResources).toHaveBeenCalledOnce();

    await supervisor.sample("turn-complete");
    await supervisor.sample("turn-complete");
    expect(releaseTransientResources).toHaveBeenCalledOnce();
    expect(supervisor.snapshot.state).toBe("shedding");

    residentMemoryBytes = policy.resumeProcessRssBytes - 1;
    await supervisor.sample("interval");
    expect(supervisor.snapshot.admissionPaused).toBe(false);
    expect(supervisor.snapshot.state).toBe("ready");

    residentMemoryBytes = policy.softProcessRssBytes + 1;
    await supervisor.sample("admission");
    await supervisor.sample("turn-complete");
    expect(releaseTransientResources).toHaveBeenCalledTimes(2);
  });

  it("schedules one shed when idle pressure is observed by interval or admission samples", async () => {
    const policy = resourcePolicy();
    const releaseTransientResources = vi.fn(async () => undefined);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => policy.softProcessRssBytes + 1,
      spoolBytes: () => 0,
      scheduleAtTurnBoundary: runImmediately,
      releaseTransientResources,
      replaceWorker: async () => 2,
      drain: async () => undefined,
    });

    await supervisor.sample("interval");
    await supervisor.sample("admission");

    expect(releaseTransientResources).toHaveBeenCalledOnce();
    expect(supervisor.snapshot).toMatchObject({ state: "shedding", admissionPaused: true });
  });

  it("coalesces concurrent soft-pressure samples behind one shed operation", async () => {
    const policy = resourcePolicy();
    let releaseShed!: () => void;
    const shedGate = new Promise<void>((resolve) => {
      releaseShed = resolve;
    });
    const releaseTransientResources = vi.fn(() => shedGate);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => policy.softProcessRssBytes + 1,
      spoolBytes: () => 0,
      scheduleAtTurnBoundary: runImmediately,
      releaseTransientResources,
      replaceWorker: async () => 2,
      drain: async () => undefined,
    });

    const samples = Promise.all([
      supervisor.sample("turn-complete"),
      supervisor.sample("turn-complete"),
      supervisor.sample("interval"),
    ]);
    await Promise.resolve();

    expect(releaseTransientResources).toHaveBeenCalledOnce();
    releaseShed();
    await samples;
  });

  it("returns a failed shed to a retryable state", async () => {
    const policy = resourcePolicy();
    const replaceWorker = vi.fn(async () => 2);
    const releaseTransientResources = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("release failed"))
      .mockResolvedValueOnce(undefined);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => policy.softProcessRssBytes + 1,
      spoolBytes: () => 0,
      scheduleAtTurnBoundary: runImmediately,
      releaseTransientResources,
      replaceWorker,
      drain: async () => undefined,
    });

    await expect(supervisor.sample("interval")).rejects.toThrow("release failed");
    expect(replaceWorker).toHaveBeenCalledOnce();
    expect(supervisor.snapshot).toMatchObject({
      state: "ready",
      generation: 2,
      admissionPaused: false,
    });
    await expect(supervisor.sample("interval")).resolves.toBeUndefined();

    expect(releaseTransientResources).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot).toMatchObject({ state: "shedding", admissionPaused: true });
  });

  it("replaces once at hard pressure and fences heap reports by generation", async () => {
    const policy = resourcePolicy();
    const replaceWorker = vi.fn(async () => 2);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => policy.hardProcessRssBytes + 1,
      spoolBytes: () => 4096,
      scheduleAtTurnBoundary: runImmediately,
      releaseTransientResources: async () => undefined,
      replaceWorker,
      drain: async () => undefined,
    });
    supervisor.workerHeapReported(1, 100, 200, 400);

    await Promise.all([supervisor.sample("admission"), supervisor.sample("interval")]);

    expect(replaceWorker).toHaveBeenCalledOnce();
    expect(supervisor.snapshot).toMatchObject({
      state: "ready",
      generation: 2,
      processRssBytes: policy.hardProcessRssBytes + 1,
      peakProcessRssBytes: policy.hardProcessRssBytes + 1,
      spoolBytes: 4096,
      admissionPaused: false,
      replacementCount: 1,
      peakWorkerHeapUsedBytes: 400,
    });
    expect(supervisor.snapshot.workerHeapUsedBytes).toBeUndefined();
    supervisor.workerHeapReported(1, 300, 400, 600);
    expect(supervisor.snapshot.workerHeapUsedBytes).toBeUndefined();
    supervisor.workerHeapReported(2, 200, 600, 300);
    expect(supervisor.snapshot.workerHeapUsedBytes).toBe(200);
    expect(supervisor.snapshot.peakWorkerHeapUsedBytes).toBe(400);
    expect(supervisor.snapshot.processRssBytes).toBe(policy.hardProcessRssBytes + 1);
  });

  it("recovers current worker exits through the worker recovery port", async () => {
    const policy = resourcePolicy();
    const replaceWorker = vi.fn(async () => 2);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => 0,
      spoolBytes: () => 0,
      scheduleAtTurnBoundary: runImmediately,
      releaseTransientResources: async () => undefined,
      replaceWorker,
      drain: async () => undefined,
    });
    const recovery: DaemonWorkerExitRecovery = supervisor;

    await recovery.recover({ generation: 0, cause: "error" });
    await recovery.recover({ generation: 1, cause: "out-of-memory" });

    expect(replaceWorker).toHaveBeenCalledOnce();
    expect(replaceWorker).toHaveBeenCalledWith("out-of-memory");
    expect(supervisor.snapshot).toMatchObject({ generation: 2, replacementCount: 1 });
  });

  it("reports large disk spools without treating them as process RSS", async () => {
    const policy = resourcePolicy();
    const replaceWorker = vi.fn(async () => 2);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => policy.resumeProcessRssBytes - 1,
      spoolBytes: () => 12 * MEBIBYTE,
      scheduleAtTurnBoundary: runImmediately,
      releaseTransientResources: async () => undefined,
      replaceWorker,
      drain: async () => undefined,
    });

    await supervisor.sample("admission");

    expect(supervisor.snapshot).toMatchObject({
      state: "ready",
      processRssBytes: policy.resumeProcessRssBytes - 1,
      spoolBytes: 12 * MEBIBYTE,
      admissionPaused: false,
    });
    expect(replaceWorker).not.toHaveBeenCalled();
  });

  it("drains on a third pressure replacement inside ten minutes", async () => {
    const policy = resourcePolicy();
    let generation = 1;
    let now = 0;
    const replaceWorker = vi.fn(async () => (generation += 1));
    const drain = vi.fn(async () => undefined);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation,
      now: () => now,
      residentMemoryBytes: () => policy.hardProcessRssBytes + 1,
      spoolBytes: () => 0,
      scheduleAtTurnBoundary: runImmediately,
      releaseTransientResources: async () => undefined,
      replaceWorker,
      drain,
    });

    await supervisor.sample("interval");
    now += 60_000;
    await supervisor.sample("interval");
    now += 60_000;
    await supervisor.sample("interval");

    expect(replaceWorker).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenCalledOnce();
    expect(supervisor.snapshot).toMatchObject({ state: "draining", replacementCount: 2 });
  });

  it("does not open the replacement circuit outside the ten minute window", async () => {
    const policy = resourcePolicy();
    let generation = 1;
    let now = 0;
    const replaceWorker = vi.fn(async () => (generation += 1));
    const drain = vi.fn(async () => undefined);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation,
      now: () => now,
      residentMemoryBytes: () => policy.hardProcessRssBytes + 1,
      spoolBytes: () => 0,
      scheduleAtTurnBoundary: runImmediately,
      releaseTransientResources: async () => undefined,
      replaceWorker,
      drain,
    });

    await supervisor.sample("interval");
    now += 10 * 60 * 1_000 + 1;
    await supervisor.sample("interval");
    now += 10 * 60 * 1_000 + 1;
    await supervisor.sample("interval");

    expect(replaceWorker).toHaveBeenCalledTimes(3);
    expect(drain).not.toHaveBeenCalled();
    expect(supervisor.snapshot).toMatchObject({ state: "ready", replacementCount: 3 });
  });
});

function runImmediately(operation: () => Promise<void>): Promise<void> {
  return operation();
}

function resourcePolicy() {
  return DaemonPolicy.fromSystemMemory({ totalBytes: GIBIBYTE }).values.resources;
}
