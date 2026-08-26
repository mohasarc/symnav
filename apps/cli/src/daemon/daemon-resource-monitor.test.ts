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

  it("pauses admission at soft pressure and sheds once at a turn boundary", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(GIBIBYTE);
    let residentMemoryBytes = policy.record.softProcessRssBytes + 1;
    const releaseTransientResources = vi.fn(async () => undefined);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => residentMemoryBytes,
      spoolBytes: () => 0,
      releaseTransientResources,
      replaceWorker: async () => 2,
      drain: async () => undefined,
    });

    await supervisor.sample("admission");
    await supervisor.sample("interval");
    expect(supervisor.snapshot.admissionPaused).toBe(true);
    expect(releaseTransientResources).not.toHaveBeenCalled();

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

  it("replaces once at hard pressure and fences heap reports by generation", async () => {
    const policy = DaemonResourcePolicy.fromSystemMemory(GIBIBYTE);
    const replaceWorker = vi.fn(async () => 2);
    const supervisor = new DaemonResourceSupervisor({
      policy,
      generation: 1,
      residentMemoryBytes: () => policy.record.hardProcessRssBytes + 1,
      spoolBytes: () => 4096,
      releaseTransientResources: async () => undefined,
      replaceWorker,
      drain: async () => undefined,
    });
    supervisor.workerHeapReported(1, 100, 200);

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
    });
    expect(supervisor.snapshot.workerHeapUsedBytes).toBeUndefined();
    supervisor.workerHeapReported(1, 300, 400);
    expect(supervisor.snapshot.workerHeapUsedBytes).toBeUndefined();
    supervisor.workerHeapReported(2, 500, 600);
    expect(supervisor.snapshot.workerHeapUsedBytes).toBe(500);
    expect(supervisor.snapshot.processRssBytes).toBe(policy.record.hardProcessRssBytes + 1);
  });
});
