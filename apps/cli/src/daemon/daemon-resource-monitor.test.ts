import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAEMON_RESOURCE_SAMPLE_INTERVAL_MS,
  DaemonResourcePolicy,
  DaemonResourceSupervisor,
} from "./daemon-resource-monitor.js";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

describe("DaemonResourcePolicy", () => {
  it.each([
    {
      memory: 256 * MEBIBYTE,
      hard: 256 * MEBIBYTE,
      soft: 204 * MEBIBYTE,
      resume: 179 * MEBIBYTE,
      worker: 128,
    },
    {
      memory: 512 * MEBIBYTE,
      hard: 256 * MEBIBYTE,
      soft: 204 * MEBIBYTE,
      resume: 179 * MEBIBYTE,
      worker: 128,
    },
    {
      memory: GIBIBYTE,
      hard: 512 * MEBIBYTE,
      soft: 409 * MEBIBYTE,
      resume: 358 * MEBIBYTE,
      worker: 256,
    },
    {
      memory: 16 * GIBIBYTE,
      hard: 8 * GIBIBYTE,
      soft: 6553 * MEBIBYTE,
      resume: 5734 * MEBIBYTE,
      worker: 4096,
    },
    {
      memory: 64 * GIBIBYTE,
      hard: 8 * GIBIBYTE,
      soft: 6553 * MEBIBYTE,
      resume: 5734 * MEBIBYTE,
      worker: 4096,
    },
  ])("derives bounded thresholds from $memory bytes", ({ memory, hard, soft, resume, worker }) => {
    const record = DaemonResourcePolicy.fromSystemMemory(memory).record;

    expect(record).toEqual({
      effectiveMemoryBytes: memory,
      hardProcessRssBytes: hard,
      softProcessRssBytes: soft,
      resumeProcessRssBytes: resume,
      workerMaxOldGenerationSizeMb: worker,
    });
  });

  it("prefers a smaller positive constrained-memory limit", () => {
    expect(DaemonResourcePolicy.fromSystemMemory(64 * GIBIBYTE, GIBIBYTE).record).toEqual(
      DaemonResourcePolicy.fromSystemMemory(GIBIBYTE).record,
    );
    expect(DaemonResourcePolicy.fromSystemMemory(GIBIBYTE, 16 * GIBIBYTE).record).toEqual(
      DaemonResourcePolicy.fromSystemMemory(GIBIBYTE).record,
    );
  });

  it("uses a 250 millisecond supervision interval", () => {
    expect(DAEMON_RESOURCE_SAMPLE_INTERVAL_MS).toBe(250);
  });
});

describe("DaemonResourceSupervisor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("samples every 250 milliseconds without blocking the timer owner", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(GIBIBYTE);
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

  it("pauses admission and sheds once per soft-pressure hysteresis cycle", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(GIBIBYTE);
    let residentMemoryBytes = policy.record.softProcessRssBytes + 1;
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

    residentMemoryBytes = policy.record.resumeProcessRssBytes - 1;
    await supervisor.sample("interval");
    expect(supervisor.snapshot.admissionPaused).toBe(false);
    expect(supervisor.snapshot.state).toBe("ready");

    residentMemoryBytes = policy.record.softProcessRssBytes + 1;
    await supervisor.sample("admission");
    await supervisor.sample("turn-complete");
    expect(releaseTransientResources).toHaveBeenCalledTimes(2);
  });

  it("schedules one shed when idle pressure is observed by interval or admission samples", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(GIBIBYTE);
    const releaseTransientResources = vi.fn(async () => undefined);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => policy.record.softProcessRssBytes + 1,
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
    const policy = DaemonResourcePolicy.fromSystemMemory(GIBIBYTE);
    let releaseShed!: () => void;
    const shedGate = new Promise<void>((resolve) => {
      releaseShed = resolve;
    });
    const releaseTransientResources = vi.fn(() => shedGate);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => policy.record.softProcessRssBytes + 1,
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
    const policy = DaemonResourcePolicy.fromSystemMemory(GIBIBYTE);
    const replaceWorker = vi.fn(async () => 2);
    const releaseTransientResources = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("release failed"))
      .mockResolvedValueOnce(undefined);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => policy.record.softProcessRssBytes + 1,
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
    const policy = DaemonResourcePolicy.fromSystemMemory(GIBIBYTE);
    const replaceWorker = vi.fn(async () => 2);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => policy.record.hardProcessRssBytes + 1,
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
      processRssBytes: policy.record.hardProcessRssBytes + 1,
      peakProcessRssBytes: policy.record.hardProcessRssBytes + 1,
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
    expect(supervisor.snapshot.processRssBytes).toBe(policy.record.hardProcessRssBytes + 1);
  });

  it("reports large disk spools without treating them as process RSS", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(GIBIBYTE);
    const replaceWorker = vi.fn(async () => 2);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => policy.record.resumeProcessRssBytes - 1,
      spoolBytes: () => 12 * MEBIBYTE,
      scheduleAtTurnBoundary: runImmediately,
      releaseTransientResources: async () => undefined,
      replaceWorker,
      drain: async () => undefined,
    });

    await supervisor.sample("admission");

    expect(supervisor.snapshot).toMatchObject({
      state: "ready",
      processRssBytes: policy.record.resumeProcessRssBytes - 1,
      spoolBytes: 12 * MEBIBYTE,
      admissionPaused: false,
    });
    expect(replaceWorker).not.toHaveBeenCalled();
  });

  it("drains on a third pressure replacement inside ten minutes", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(GIBIBYTE);
    let generation = 1;
    let now = 0;
    const replaceWorker = vi.fn(async () => (generation += 1));
    const drain = vi.fn(async () => undefined);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation,
      now: () => now,
      residentMemoryBytes: () => policy.record.hardProcessRssBytes + 1,
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
    const policy = DaemonResourcePolicy.fromSystemMemory(GIBIBYTE);
    let generation = 1;
    let now = 0;
    const replaceWorker = vi.fn(async () => (generation += 1));
    const drain = vi.fn(async () => undefined);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation,
      now: () => now,
      residentMemoryBytes: () => policy.record.hardProcessRssBytes + 1,
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
