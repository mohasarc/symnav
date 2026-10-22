import { DaemonPolicy } from "@symnav/daemon";

export interface TestDaemonResourcePolicyRecord {
  readonly effectiveMemoryBytes: number;
  readonly hardProcessRssBytes: number;
  readonly softProcessRssBytes: number;
  readonly resumeProcessRssBytes: number;
  readonly workerMaxOldGenerationSizeMb: number;
  readonly replacementWindowMs: number;
  readonly replacementLimit: number;
}

export class TestDaemonResourcePolicy {
  private constructor(readonly record: TestDaemonResourcePolicyRecord) {}

  static fromSystemMemory(
    totalMemoryBytes: number,
    constrainedMemoryBytes?: number,
  ): TestDaemonResourcePolicy {
    const resources = DaemonPolicy.fromSystemMemory({
      totalBytes: totalMemoryBytes,
      ...(constrainedMemoryBytes === undefined ? {} : { constrainedBytes: constrainedMemoryBytes }),
    }).values.resources;
    return new TestDaemonResourcePolicy({
      effectiveMemoryBytes: resources.effectiveMemoryBytes,
      hardProcessRssBytes: resources.hardProcessRssBytes,
      softProcessRssBytes: resources.softProcessRssBytes,
      resumeProcessRssBytes: resources.resumeProcessRssBytes,
      workerMaxOldGenerationSizeMb: resources.workerMaxOldGenerationSizeMiB,
      replacementWindowMs: resources.replacementWindowMs,
      replacementLimit: resources.replacementLimit,
    });
  }
}
