import { DaemonPolicy } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import { performance } from "node:perf_hooks";
import { NodeDaemonClock, type DaemonClock } from "../../src/daemon/daemon-clock.js";
import type { ProgramDependencies } from "../../src/program-dependencies.js";
import type { DaemonRequestServer } from "../../src/daemon/daemon-transport.js";
import type { TestDaemonResourcePolicy as DaemonResourcePolicy } from "./daemon-resource-policy.js";
import {
  DaemonProcessCoordinator as RuntimeDaemonProcessCoordinator,
  type DaemonProcessCoordinatorOptions,
} from "../../src/daemon/daemon-process-coordinator.js";

interface TestDaemonProcessCoordinatorPolicyOptions {
  readonly policy?: DaemonPolicy;
  readonly memoryCapBytes?: number;
  readonly resourcePolicy?: DaemonResourcePolicy;
  readonly idleTimeoutMs?: number;
  readonly resourceCheckIntervalMs?: number;
  readonly startupHeartbeatIntervalMs?: number;
  readonly completionSpoolLimits?: {
    readonly inlineBytes?: number;
    readonly maximumResultBytes?: number;
    readonly maximumAggregateBytes?: number;
  };
  readonly operationTraceRetentionMs?: number;
  readonly maximumRetainedOperationTraces?: number;
}

export type TestDaemonProcessCoordinatorOptions = Omit<
  DaemonProcessCoordinatorOptions,
  "clock" | "coordinates" | "productVersion" | "server" | "workspaceExists" | "policy"
> &
  TestDaemonProcessCoordinatorPolicyOptions & {
    readonly dependencies: ProgramDependencies;
    readonly instanceId: string;
    readonly processToken: string;
    readonly symnavVersion: string;
    readonly transport: DaemonRequestServer;
    readonly clock?: DaemonClock;
    readonly now?: () => number;
  };

export class TestDaemonProcessCoordinator extends RuntimeDaemonProcessCoordinator {
  constructor(options: TestDaemonProcessCoordinatorOptions) {
    const base = options.policy ?? options.dependencies.daemonPolicy;
    const resourceRecord = options.resourcePolicy?.record;
    const hardProcessRssBytes = resourceRecord?.hardProcessRssBytes;
    const softProcessRssBytes = resourceRecord?.softProcessRssBytes;
    const resumeProcessRssBytes = resourceRecord?.resumeProcessRssBytes;
    const aggregateBytes = options.completionSpoolLimits?.maximumAggregateBytes;
    const resultBytes =
      options.completionSpoolLimits?.maximumResultBytes ??
      (aggregateBytes === undefined
        ? undefined
        : Math.min(base.values.output.maximumResultRawBytes, aggregateBytes));
    const requestedInlineBytes = options.completionSpoolLimits?.inlineBytes;
    const inlineBytes =
      requestedInlineBytes === 0 && resultBytes !== undefined
        ? Math.max(1, Math.floor(resultBytes / 2))
        : requestedInlineBytes;
    const chunkBytes = Math.min(
      base.values.output.maximumChunkRawBytes,
      inlineBytes ?? base.values.output.inlineRawBytes,
      resultBytes ?? base.values.output.maximumResultRawBytes,
    );
    const policy = DaemonPolicyTestFactory.withOverrides(base, {
      startup: {
        ...(options.startupHeartbeatIntervalMs === undefined
          ? {}
          : { heartbeatIntervalMs: options.startupHeartbeatIntervalMs }),
      },
      shutdown: {
        ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
      },
      output: {
        maximumChunkRawBytes: chunkBytes,
        ...(inlineBytes === undefined ? {} : { inlineRawBytes: inlineBytes }),
        ...(resultBytes === undefined ? {} : { maximumResultRawBytes: resultBytes }),
        ...(aggregateBytes === undefined ? {} : { maximumAggregateSpoolRawBytes: aggregateBytes }),
      },
      resources: {
        ...(resourceRecord === undefined
          ? {}
          : {
              effectiveMemoryBytes: resourceRecord.effectiveMemoryBytes,
              hardProcessRssBytes: resourceRecord.hardProcessRssBytes,
              softProcessRssBytes: resourceRecord.softProcessRssBytes,
              resumeProcessRssBytes: resourceRecord.resumeProcessRssBytes,
              workerMaxOldGenerationSizeMiB: resourceRecord.workerMaxOldGenerationSizeMb,
              replacementWindowMs: resourceRecord.replacementWindowMs,
              replacementLimit: resourceRecord.replacementLimit,
            }),
        ...(hardProcessRssBytes === undefined ? {} : { hardProcessRssBytes }),
        ...(softProcessRssBytes === undefined ? {} : { softProcessRssBytes }),
        ...(resumeProcessRssBytes === undefined ? {} : { resumeProcessRssBytes }),
        ...(options.resourceCheckIntervalMs === undefined
          ? {}
          : { supervisionIntervalMs: options.resourceCheckIntervalMs }),
      },
      diagnostics: {
        ...(options.operationTraceRetentionMs === undefined
          ? {}
          : { disconnectedTraceRetentionMs: options.operationTraceRetentionMs }),
        ...(options.maximumRetainedOperationTraces === undefined
          ? {}
          : { maximumDisconnectedTraces: options.maximumRetainedOperationTraces }),
      },
    });
    super({
      ...options,
      coordinates: {
        workspaceRoot: options.identity.workspaceRoot,
        workspaceKey: options.identity.workspaceKey,
        stateKey: options.identity.stateKey,
        identityKey: options.identity.identityKey,
        instanceId: options.instanceId,
        processToken: options.processToken,
        endpoint: options.identity.endpoint(options.instanceId),
      },
      productVersion: options.symnavVersion,
      server: options.transport,
      workspaceExists: (workspaceRoot) => options.dependencies.fs.exists(workspaceRoot),
      clock:
        options.clock ??
        new NodeDaemonClock({
          wallNowMs: options.now ?? Date.now,
          monotonicNowMs: () => performance.now(),
        }),
      policy,
    });
  }
}
