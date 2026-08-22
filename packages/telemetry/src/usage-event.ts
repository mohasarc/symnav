export const SCHEMA_VERSION = 2;

export type Outcome = "success" | "user_error" | "crash";
export type ExecutionMode = "warm" | "cold" | "fallback";
export type ArgKind = "symbol_id" | "path" | "bare" | "empty";
export type LengthBucket = "empty" | "short" | "medium" | "long";

export interface ArgShape {
  readonly kind: ArgKind;
  readonly lengthBucket: LengthBucket;
  readonly flags: readonly string[];
}

export interface UsageEventContent {
  readonly symnavVersion: string;
  readonly command: string;
  readonly timestamp: number;
  readonly durationMs: number;
  readonly executionMode: ExecutionMode;
  readonly argShape: ArgShape;
  readonly resultCounts?: Readonly<Record<string, number>>;
  readonly workspaceId: string;
  readonly machineId: string;
}

interface SuccessOutcome {
  readonly outcome: "success";
}

interface FailureOutcome {
  readonly outcome: "user_error" | "crash";
  readonly errorReason: string;
}

export type OutcomeReport = SuccessOutcome | FailureOutcome;

export type UsageEvent = UsageEventContent &
  OutcomeReport & {
    readonly schemaVersion: number;
    readonly sessionId: string;
  };
