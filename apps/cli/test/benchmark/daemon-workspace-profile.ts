import type { DaemonCommandName } from "../../src/daemon/daemon-protocol.js";

export interface DistributionSummary {
  readonly minimum: number;
  readonly p50: number;
  readonly p95: number;
  readonly maximum: number;
}

export interface DaemonWorkspaceProfile {
  readonly schemaVersion: 1;
  readonly profileVersion: string;
  readonly visibleTypeScriptFiles: number;
  readonly sourceBytes: DistributionSummary;
  readonly sourceLines: DistributionSummary;
  readonly symbolsPerFile: DistributionSummary;
  readonly packageCount: number;
  readonly configCount: number;
  readonly projectReferenceCount: number;
  readonly importsPerFile: DistributionSummary;
  readonly referenceFanout: DistributionSummary;
  readonly aliasImportRatio: number;
  readonly workspaceImportRatio: number;
  readonly callInDegree: DistributionSummary;
  readonly callOutDegree: DistributionSummary;
  readonly callDepth: DistributionSummary;
  readonly cycleRatio: number;
  readonly declarationKindCounts: Readonly<Record<string, number>>;
  readonly representativeResultCounts: Readonly<Record<DaemonCommandName, number>>;
  readonly ignoredPathRatio: number;
  readonly nestedWorkspaceRatio: number;
}

export class DaemonWorkspaceProfileValidator {
  private static readonly fields = [
    "schemaVersion",
    "profileVersion",
    "visibleTypeScriptFiles",
    "sourceBytes",
    "sourceLines",
    "symbolsPerFile",
    "packageCount",
    "configCount",
    "projectReferenceCount",
    "importsPerFile",
    "referenceFanout",
    "aliasImportRatio",
    "workspaceImportRatio",
    "callInDegree",
    "callOutDegree",
    "callDepth",
    "cycleRatio",
    "declarationKindCounts",
    "representativeResultCounts",
    "ignoredPathRatio",
    "nestedWorkspaceRatio",
  ] as const;

  private static readonly distributionFields = ["minimum", "p50", "p95", "maximum"] as const;
  private static readonly commandNames: readonly DaemonCommandName[] = [
    "overview",
    "resolve",
    "def",
    "refs",
    "context",
    "graph",
    "stats",
    "help",
    "version",
    "unknown",
  ];

  static parse(value: unknown): DaemonWorkspaceProfile {
    if (!this.hasExactFields(value, this.fields)) throw new Error("Invalid daemon profile fields");
    if (value.schemaVersion !== 1) throw new Error("Invalid daemon profile schema version");
    if (typeof value.profileVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.profileVersion)) {
      throw new Error("Invalid daemon profile version");
    }
    for (const field of [
      "visibleTypeScriptFiles",
      "packageCount",
      "configCount",
      "projectReferenceCount",
    ] as const) {
      this.assertCount(value[field], field);
    }
    for (const field of [
      "sourceBytes",
      "sourceLines",
      "symbolsPerFile",
      "importsPerFile",
      "referenceFanout",
      "callInDegree",
      "callOutDegree",
      "callDepth",
    ] as const) {
      this.assertDistribution(value[field]);
    }
    for (const field of [
      "aliasImportRatio",
      "workspaceImportRatio",
      "cycleRatio",
      "ignoredPathRatio",
      "nestedWorkspaceRatio",
    ] as const) {
      this.assertRatio(value[field], field);
    }
    this.assertCountRecord(value.declarationKindCounts, "declaration kind counts");
    if (!this.hasExactFields(value.representativeResultCounts, this.commandNames)) {
      throw new Error("Invalid representative result fields");
    }
    this.assertCountRecord(value.representativeResultCounts, "representative result counts");
    return value as unknown as DaemonWorkspaceProfile;
  }

  private static assertDistribution(value: unknown): asserts value is DistributionSummary {
    if (!this.hasExactFields(value, this.distributionFields)) {
      throw new Error("Invalid daemon profile distribution fields");
    }
    const ordered = [value.minimum, value.p50, value.p95, value.maximum];
    if (ordered.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)) {
      throw new Error("Invalid daemon profile distribution order");
    }
    const numericOrder = ordered as number[];
    if (numericOrder.some((item, index) => index > 0 && item < numericOrder[index - 1]!)) {
      throw new Error("Invalid daemon profile distribution order");
    }
  }

  private static assertRatio(value: unknown, field: string): void {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Invalid daemon profile ${field}`);
    }
  }

  private static assertCount(value: unknown, field: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`Invalid daemon profile ${field}`);
    }
  }

  private static assertCountRecord(value: unknown, field: string): void {
    if (!this.isRecord(value) || Object.keys(value).length === 0) {
      throw new Error(`Invalid daemon profile ${field}`);
    }
    for (const count of Object.values(value)) this.assertCount(count, field);
  }

  private static hasExactFields(
    value: unknown,
    fields: readonly string[],
  ): value is Record<string, unknown> {
    if (!this.isRecord(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    return (
      actual.length === expected.length && actual.every((field, index) => field === expected[index])
    );
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export class DaemonWorkspaceProfiler {
  profile(_workspaceRoot: string): Promise<DaemonWorkspaceProfile> {
    return Promise.reject(new Error("Daemon workspace profiling is not implemented"));
  }
}
