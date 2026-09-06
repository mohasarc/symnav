const MEBIBYTE = 1024 * 1024;

interface DaemonRuntimeProcess {
  constrainedMemory?: () => number | undefined;
  binding(name: "os"): { getTotalMem(): number };
}

export interface DaemonSystemMemory {
  readonly totalBytes: number;
  readonly constrainedBytes?: number;
}

export interface DaemonPolicyValues {
  readonly transport: {
    readonly singleResponseTimeoutMs: number;
    readonly statusResponseTimeoutMs: number;
    readonly executionAdmissionTimeoutMs: number;
    readonly maximumJsonPayloadBytes: number;
    readonly maximumExecutionControlPayloadBytes: number;
  };
  readonly startup: {
    readonly coordinationGraceMs: number;
    readonly heartbeatIntervalMs: number;
    readonly authorizationPollIntervalMs: number;
    readonly observationPollIntervalMs: number;
    readonly previousInstanceTerminationTimeoutMs: number;
    readonly childFailureRetryLimit: number;
  };
  readonly shutdown: {
    readonly idleTimeoutMs: number;
    readonly stopTimeoutMs: number;
    readonly forcedTerminationReserveMaximumMs: number;
    readonly controllerPollIntervalMs: number;
    readonly processSignalExitTimeoutMs: number;
    readonly processExitPollIntervalMs: number;
    readonly resourceDrainAcknowledgementGraceMs: number;
    readonly resourceDrainAcknowledgementPollIntervalMs: number;
  };
  readonly delivery: {
    readonly postAcceptanceExecutionReattachmentLimit: number;
    readonly resultTransferResumeLimitPerExecutionAttempt: number;
  };
  readonly output: {
    readonly maximumChunkRawBytes: number;
    readonly inlineRawBytes: number;
    readonly maximumResultRawBytes: number;
    readonly maximumAggregateSpoolRawBytes: number;
  };
  readonly resources: {
    readonly effectiveMemoryBytes: number;
    readonly hardProcessRssBytes: number;
    readonly softProcessRssBytes: number;
    readonly resumeProcessRssBytes: number;
    readonly workerMaxOldGenerationSizeMiB: number;
    readonly supervisionIntervalMs: number;
    readonly replacementWindowMs: number;
    readonly replacementLimit: number;
    readonly workerHeapSampleIntervalMs: number;
  };
  readonly diagnostics: {
    readonly logRotateBytes: number;
    readonly logBackupCount: number;
    readonly maximumQueuedEvents: number;
    readonly disconnectedTraceRetentionMs: number;
    readonly maximumDisconnectedTraces: number;
  };
}

export interface SerializedDaemonPolicy {
  readonly schemaVersion: 1;
  readonly values: DaemonPolicyValues;
}

export class DaemonPolicy {
  readonly values: DaemonPolicyValues;

  private constructor(values: DaemonPolicyValues) {
    this.values = DaemonPolicy.freeze(values);
    Object.freeze(this);
  }

  static currentSystem(): DaemonPolicy {
    const runtimeProcess = (globalThis as unknown as { process: DaemonRuntimeProcess }).process;
    const constrainedBytes = runtimeProcess.constrainedMemory?.();
    return DaemonPolicy.fromSystemMemory({
      totalBytes: runtimeProcess.binding("os").getTotalMem(),
      ...(constrainedBytes === undefined ? {} : { constrainedBytes }),
    });
  }

  static fromSystemMemory(memory: DaemonSystemMemory): DaemonPolicy {
    const effectiveMemoryBytes =
      memory.constrainedBytes !== undefined &&
      memory.constrainedBytes > 0 &&
      memory.constrainedBytes < memory.totalBytes
        ? memory.constrainedBytes
        : memory.totalBytes;
    const effectiveMemoryMiB = Math.max(1, Math.floor(effectiveMemoryBytes / MEBIBYTE));
    const hardProcessRssMiB = DaemonPolicy.clamp(Math.floor(effectiveMemoryMiB / 2), 256, 8_192);
    const workerMaxOldGenerationSizeMiB = DaemonPolicy.clamp(
      Math.floor(effectiveMemoryMiB / 4),
      128,
      4_096,
    );
    return new DaemonPolicy({
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
        effectiveMemoryBytes,
        hardProcessRssBytes: hardProcessRssMiB * MEBIBYTE,
        softProcessRssBytes: Math.floor(hardProcessRssMiB * 0.8) * MEBIBYTE,
        resumeProcessRssBytes: Math.floor(hardProcessRssMiB * 0.7) * MEBIBYTE,
        workerMaxOldGenerationSizeMiB,
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
    });
  }

  static fromSerialized(value: unknown): DaemonPolicy {
    return new DaemonPolicy(DaemonPolicyCodec.parse(value));
  }

  toSerialized(): Readonly<SerializedDaemonPolicy> {
    return DaemonPolicyCodec.serialize(this);
  }

  private static clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
  }

  private static freeze(values: DaemonPolicyValues): DaemonPolicyValues {
    for (const section of Object.values(values)) Object.freeze(section);
    return Object.freeze(values);
  }
}

export class DaemonPolicyCodec {
  static serialize(policy: DaemonPolicy): SerializedDaemonPolicy {
    return Object.freeze({ schemaVersion: 1, values: policy.values });
  }

  static parse(value: unknown): DaemonPolicyValues {
    if (!DaemonPolicyCodec.isRecord(value)) throw new Error("Invalid daemon policy");
    DaemonPolicyCodec.exactKeys(value, ["schemaVersion", "values"]);
    if (value.schemaVersion !== 1 || !DaemonPolicyCodec.isRecord(value.values)) {
      throw new Error("Invalid daemon policy");
    }
    const values = value.values;
    DaemonPolicyCodec.validateValues(values);
    return JSON.parse(JSON.stringify(values)) as DaemonPolicyValues;
  }

  private static validateValues(values: Record<string, unknown>): void {
    DaemonPolicyCodec.exactKeys(values, [
      "transport",
      "startup",
      "shutdown",
      "delivery",
      "output",
      "resources",
      "diagnostics",
    ]);
    const transport = DaemonPolicyCodec.section(values, "transport", [
      "singleResponseTimeoutMs",
      "statusResponseTimeoutMs",
      "executionAdmissionTimeoutMs",
      "maximumJsonPayloadBytes",
      "maximumExecutionControlPayloadBytes",
    ]);
    const startup = DaemonPolicyCodec.section(values, "startup", [
      "coordinationGraceMs",
      "heartbeatIntervalMs",
      "authorizationPollIntervalMs",
      "observationPollIntervalMs",
      "previousInstanceTerminationTimeoutMs",
      "childFailureRetryLimit",
    ]);
    const shutdown = DaemonPolicyCodec.section(values, "shutdown", [
      "idleTimeoutMs",
      "stopTimeoutMs",
      "forcedTerminationReserveMaximumMs",
      "controllerPollIntervalMs",
      "processSignalExitTimeoutMs",
      "processExitPollIntervalMs",
      "resourceDrainAcknowledgementGraceMs",
      "resourceDrainAcknowledgementPollIntervalMs",
    ]);
    const delivery = DaemonPolicyCodec.section(values, "delivery", [
      "postAcceptanceExecutionReattachmentLimit",
      "resultTransferResumeLimitPerExecutionAttempt",
    ]);
    const output = DaemonPolicyCodec.section(values, "output", [
      "maximumChunkRawBytes",
      "inlineRawBytes",
      "maximumResultRawBytes",
      "maximumAggregateSpoolRawBytes",
    ]);
    const resources = DaemonPolicyCodec.section(values, "resources", [
      "effectiveMemoryBytes",
      "hardProcessRssBytes",
      "softProcessRssBytes",
      "resumeProcessRssBytes",
      "workerMaxOldGenerationSizeMiB",
      "supervisionIntervalMs",
      "replacementWindowMs",
      "replacementLimit",
      "workerHeapSampleIntervalMs",
    ]);
    const diagnostics = DaemonPolicyCodec.section(values, "diagnostics", [
      "logRotateBytes",
      "logBackupCount",
      "maximumQueuedEvents",
      "disconnectedTraceRetentionMs",
      "maximumDisconnectedTraces",
    ]);
    for (const section of [
      transport,
      startup,
      shutdown,
      delivery,
      output,
      resources,
      diagnostics,
    ]) {
      for (const value of Object.values(section)) DaemonPolicyCodec.nonnegativeInteger(value);
    }
    for (const [section, key] of [
      [startup, "heartbeatIntervalMs"],
      [startup, "authorizationPollIntervalMs"],
      [startup, "observationPollIntervalMs"],
      [shutdown, "controllerPollIntervalMs"],
      [shutdown, "processExitPollIntervalMs"],
      [shutdown, "resourceDrainAcknowledgementPollIntervalMs"],
      [resources, "supervisionIntervalMs"],
      [resources, "workerHeapSampleIntervalMs"],
    ] as const) {
      if (DaemonPolicyCodec.integer(section, key) <= 0) throw new Error("Invalid daemon policy");
    }
    const hardProcessRssBytes = DaemonPolicyCodec.integer(resources, "hardProcessRssBytes");
    const softProcessRssBytes = DaemonPolicyCodec.integer(resources, "softProcessRssBytes");
    const resumeProcessRssBytes = DaemonPolicyCodec.integer(resources, "resumeProcessRssBytes");
    if (
      hardProcessRssBytes <= softProcessRssBytes ||
      softProcessRssBytes <= resumeProcessRssBytes
    ) {
      throw new Error("Invalid daemon policy");
    }
    const maximumChunkRawBytes = DaemonPolicyCodec.integer(output, "maximumChunkRawBytes");
    const inlineRawBytes = DaemonPolicyCodec.integer(output, "inlineRawBytes");
    const maximumResultRawBytes = DaemonPolicyCodec.integer(output, "maximumResultRawBytes");
    const maximumAggregateSpoolRawBytes = DaemonPolicyCodec.integer(
      output,
      "maximumAggregateSpoolRawBytes",
    );
    if (
      maximumChunkRawBytes === 0 ||
      maximumChunkRawBytes > inlineRawBytes ||
      inlineRawBytes > maximumResultRawBytes ||
      maximumResultRawBytes > maximumAggregateSpoolRawBytes
    ) {
      throw new Error("Invalid daemon policy");
    }
  }

  private static section(
    values: Record<string, unknown>,
    name: string,
    keys: readonly string[],
  ): Record<string, unknown> {
    const section = values[name];
    if (!DaemonPolicyCodec.isRecord(section)) throw new Error("Invalid daemon policy");
    DaemonPolicyCodec.exactKeys(section, keys);
    return section;
  }

  private static exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      throw new Error("Invalid daemon policy");
    }
  }

  private static nonnegativeInteger(value: unknown): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error("Invalid daemon policy");
    }
  }

  private static integer(section: Record<string, unknown>, key: string): number {
    const value = section[key];
    DaemonPolicyCodec.nonnegativeInteger(value);
    return value;
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
