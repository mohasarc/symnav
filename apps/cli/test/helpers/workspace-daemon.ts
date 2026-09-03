import { DaemonPolicy } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import type { TestDaemonResourcePolicy as DaemonResourcePolicy } from "./daemon-resource-policy.js";
import {
  WorkspaceDaemon as RuntimeWorkspaceDaemon,
  type WorkspaceDaemonOptions,
} from "../../src/daemon/workspace-daemon.js";

interface TestWorkspaceDaemonPolicyOptions {
  readonly policy?: DaemonPolicy;
  readonly memoryCapBytes?: number;
  readonly resourcePolicy?: DaemonResourcePolicy;
  readonly resourceCheckIntervalMs?: number;
  readonly completionSpoolLimits?: {
    readonly inlineBytes?: number;
    readonly maximumResultBytes?: number;
    readonly maximumAggregateBytes?: number;
  };
}

export type TestWorkspaceDaemonOptions = Omit<WorkspaceDaemonOptions, "policy"> &
  TestWorkspaceDaemonPolicyOptions;

export class TestWorkspaceDaemon extends RuntimeWorkspaceDaemon {
  constructor(options: TestWorkspaceDaemonOptions) {
    const base = options.policy ?? options.dependencies.daemonPolicy;
    const resourceRecord = options.resourcePolicy?.record;
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
        ...(options.resourceCheckIntervalMs === undefined
          ? {}
          : { supervisionIntervalMs: options.resourceCheckIntervalMs }),
      },
    });
    super({ ...options, policy });
  }
}
