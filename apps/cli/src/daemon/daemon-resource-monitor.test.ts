import { describe, expect, it } from "vitest";
import {
  DAEMON_RESOURCE_SAMPLE_INTERVAL_MS,
  DaemonResourcePolicy,
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
