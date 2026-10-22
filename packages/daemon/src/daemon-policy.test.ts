import { describe, expect, it } from "vitest";

import { DaemonPolicy, type DaemonPolicyValues } from "./index.js";
import { DaemonPolicyTestFactory } from "../test/helpers/daemon-policy.js";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

const expectedDefaults: DaemonPolicyValues = {
  transport: {
    singleResponseTimeoutMs: 250,
    statusResponseTimeoutMs: 100,
    executionAdmissionTimeoutMs: 5_000,
    maximumJsonPayloadBytes: 8 * MEBIBYTE,
    maximumExecutionControlPayloadBytes: 256 * 1024,
  },
  startup: {
    coordinationGraceMs: 15_000,
    heartbeatIntervalMs: 100,
    authorizationPollIntervalMs: 10,
    observationPollIntervalMs: 20,
    previousInstanceTerminationTimeoutMs: 5 * 60_000,
    childFailureRetryLimit: 1,
  },
  shutdown: {
    idleTimeoutMs: 30 * 60_000,
    stopTimeoutMs: 5_000,
    forcedTerminationReserveMaximumMs: 500,
    controllerPollIntervalMs: 20,
    processSignalExitTimeoutMs: 500,
    processExitPollIntervalMs: 20,
    resourceDrainAcknowledgementGraceMs: 250,
    resourceDrainAcknowledgementPollIntervalMs: 5,
  },
  delivery: {
    postAcceptanceExecutionReattachmentLimit: 1,
    resultTransferResumeLimitPerExecutionAttempt: 1,
  },
  output: {
    maximumChunkRawBytes: 64 * 1024,
    inlineRawBytes: 256 * 1024,
    maximumResultRawBytes: 256 * MEBIBYTE,
    maximumAggregateSpoolRawBytes: 512 * MEBIBYTE,
  },
  resources: {
    effectiveMemoryBytes: GIBIBYTE,
    hardProcessRssBytes: 512 * MEBIBYTE,
    softProcessRssBytes: 409 * MEBIBYTE,
    resumeProcessRssBytes: 358 * MEBIBYTE,
    workerMaxOldGenerationSizeMiB: 256,
    supervisionIntervalMs: 250,
    replacementWindowMs: 10 * 60_000,
    replacementLimit: 2,
    workerHeapSampleIntervalMs: 25,
  },
  diagnostics: {
    logRotateBytes: 10 * MEBIBYTE,
    logBackupCount: 4,
    maximumQueuedEvents: 1_024,
    disconnectedTraceRetentionMs: 5 * 60_000,
    maximumDisconnectedTraces: 1_024,
  },
};

describe("DaemonPolicy", () => {
  it("defines every default leaf in one complete snapshot", () => {
    expect(DaemonPolicy.fromSystemMemory({ totalBytes: GIBIBYTE }).values).toEqual(
      expectedDefaults,
    );
  });

  it.each([
    ["positive lower constraint", 64 * GIBIBYTE, GIBIBYTE, GIBIBYTE],
    ["zero constraint", GIBIBYTE, 0, GIBIBYTE],
    ["negative constraint", GIBIBYTE, -1, GIBIBYTE],
    ["larger constraint", GIBIBYTE, 16 * GIBIBYTE, GIBIBYTE],
    ["equal constraint", GIBIBYTE, GIBIBYTE, GIBIBYTE],
    ["raw bytes", GIBIBYTE + 123, undefined, GIBIBYTE + 123],
  ])("selects effective memory for %s", (_, totalBytes, constrainedBytes, expected) => {
    const systemMemory =
      constrainedBytes === undefined ? { totalBytes } : { totalBytes, constrainedBytes };
    expect(DaemonPolicy.fromSystemMemory(systemMemory).values.resources).toMatchObject({
      effectiveMemoryBytes: expected,
    });
  });

  it.each([
    [1, 256, 204, 179, 128],
    [512 * MEBIBYTE, 256, 204, 179, 128],
    [GIBIBYTE, 512, 409, 358, 256],
    [16 * GIBIBYTE, 8_192, 6_553, 5_734, 4_096],
    [64 * GIBIBYTE, 8_192, 6_553, 5_734, 4_096],
  ])(
    "derives memory thresholds from %i raw bytes",
    (totalBytes, hardMiB, softMiB, resumeMiB, workerMiB) => {
      const resources = DaemonPolicy.fromSystemMemory({ totalBytes }).values.resources;
      expect(resources).toMatchObject({
        hardProcessRssBytes: hardMiB * MEBIBYTE,
        softProcessRssBytes: softMiB * MEBIBYTE,
        resumeProcessRssBytes: resumeMiB * MEBIBYTE,
        workerMaxOldGenerationSizeMiB: workerMiB,
      });
    },
  );

  it("freezes every snapshot level and keeps equal timings independently overrideable", () => {
    const policy = DaemonPolicyTestFactory.withOverrides(
      DaemonPolicy.fromSystemMemory({ totalBytes: GIBIBYTE }),
      {
        startup: { observationPollIntervalMs: 21 },
        shutdown: { controllerPollIntervalMs: 22, processExitPollIntervalMs: 23 },
      },
    );
    expect(policy.values.startup.observationPollIntervalMs).toBe(21);
    expect(policy.values.shutdown.controllerPollIntervalMs).toBe(22);
    expect(policy.values.shutdown.processExitPollIntervalMs).toBe(23);
    expect(Object.isFrozen(policy.values)).toBe(true);
    for (const section of Object.values(policy.values)) expect(Object.isFrozen(section)).toBe(true);
  });

  it("round-trips only one complete exact versioned snapshot", () => {
    const policy = DaemonPolicyTestFactory.withOverrides(
      DaemonPolicy.fromSystemMemory({ totalBytes: GIBIBYTE }),
      { transport: { singleResponseTimeoutMs: 991 } },
    );
    const serialized = policy.toSerialized();
    expect(DaemonPolicy.fromSerialized(serialized).values).toEqual(policy.values);
    expect(Object.isFrozen(serialized)).toBe(true);
    expect(Object.isFrozen(serialized.values)).toBe(true);
  });

  it.each([
    ["missing key", (value: any) => delete value.values.transport.singleResponseTimeoutMs],
    ["extra key", (value: any) => (value.values.transport.extra = 1)],
    ["wrong schema", (value: any) => (value.schemaVersion = 2)],
    ["NaN", (value: any) => (value.values.output.inlineRawBytes = Number.NaN)],
    ["Infinity", (value: any) => (value.values.shutdown.stopTimeoutMs = Number.POSITIVE_INFINITY)],
    ["unsafe count", (value: any) => (value.values.diagnostics.logBackupCount = 2 ** 53)],
    [
      "negative count",
      (value: any) => (value.values.delivery.postAcceptanceExecutionReattachmentLimit = -1),
    ],
    ["zero poll interval", (value: any) => (value.values.resources.workerHeapSampleIntervalMs = 0)],
    ["zero chunk capacity", (value: any) => (value.values.output.maximumChunkRawBytes = 0)],
    [
      "invalid hysteresis",
      (value: any) =>
        (value.values.resources.resumeProcessRssBytes = value.values.resources.softProcessRssBytes),
    ],
    [
      "invalid output ordering",
      (value: any) =>
        (value.values.output.inlineRawBytes = value.values.output.maximumResultRawBytes + 1),
    ],
  ])("rejects %s", (_, mutate) => {
    const value = structuredClone(
      DaemonPolicy.fromSystemMemory({ totalBytes: GIBIBYTE }).toSerialized(),
    );
    mutate(value);
    expect(() => DaemonPolicy.fromSerialized(value)).toThrow("Invalid daemon policy");
  });
});
