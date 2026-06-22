export const SCHEMA_VERSION = 1;

export type Outcome = "success" | "user_error" | "crash";
export type ArgKind = "symbol_id" | "path" | "bare" | "empty";
export type LengthBucket = "empty" | "short" | "medium" | "long";

export interface ArgShape {
  readonly kind: ArgKind;
  readonly lengthBucket: LengthBucket;
  readonly flags: readonly string[];
}

interface UsageEventBase {
  readonly schemaVersion: number;
  readonly symnavVersion: string;
  readonly command: string;
  readonly timestamp: number;
  readonly durationMs: number;
  readonly argShape: ArgShape;
  readonly resultCounts?: Readonly<Record<string, number>>;
  readonly workspaceId: string;
  readonly machineId: string;
  readonly sessionId: string;
}

export interface SuccessEvent extends UsageEventBase {
  readonly outcome: "success";
}

export interface FailureEvent extends UsageEventBase {
  readonly outcome: "user_error" | "crash";
  readonly errorReason: string;
}

export type UsageEvent = SuccessEvent | FailureEvent;
