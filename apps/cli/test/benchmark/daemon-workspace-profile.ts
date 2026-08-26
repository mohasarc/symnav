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
  static parse(_value: unknown): DaemonWorkspaceProfile {
    throw new Error("Daemon workspace profile validation is not implemented");
  }
}

export class DaemonWorkspaceProfiler {
  profile(_workspaceRoot: string): Promise<DaemonWorkspaceProfile> {
    return Promise.reject(new Error("Daemon workspace profiling is not implemented"));
  }
}
