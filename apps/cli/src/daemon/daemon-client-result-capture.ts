import type {
  DaemonExecutorExecutionResult,
  DaemonPolicyValues,
  DaemonSequencedOutputRecord,
} from "@symnav/daemon";

export interface DaemonOutputCapture {
  append(record: DaemonSequencedOutputRecord): Promise<void>;
  finish(exitCode: number): Promise<DaemonCapturedOutput>;
  dispose(): Promise<void>;
}

export interface DaemonCapturedOutputSummary {
  readonly rawBytes: number;
  readonly recordCount: number;
  readonly sha256: string;
}

export interface DaemonCapturedOutput {
  readonly result: DaemonExecutorExecutionResult;
  readonly summary: DaemonCapturedOutputSummary;
}

export interface DaemonClientResultCaptureOptions {
  readonly directory?: string;
  readonly policy: Pick<
    DaemonPolicyValues["output"],
    "maximumChunkRawBytes" | "inlineRawBytes" | "maximumResultRawBytes"
  >;
}
