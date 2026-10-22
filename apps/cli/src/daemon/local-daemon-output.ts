import type { DaemonOutputStream, DaemonPolicyValues } from "@symnav/daemon";
import { OrderedCommandOutput } from "../command-execution-result.js";

export interface LocalDaemonOutputRecord {
  readonly sequence: number;
  readonly stream: DaemonOutputStream;
  readonly bytes: Uint8Array;
}

export interface LocalDaemonOutputSummary {
  readonly rawBytes: number;
  readonly recordCount: number;
  readonly sha256: string;
}

export interface LocalDaemonStoredOutput {
  readonly summary: LocalDaemonOutputSummary;
  records(offset?: number): AsyncIterable<LocalDaemonOutputRecord>;
  dispose(): Promise<void>;
}

export interface LocalDaemonExecutionResult {
  readonly output: LocalDaemonStoredOutput;
  readonly exitCode: number;
}

export class LocalDaemonOutput {
  private readonly output: OrderedCommandOutput;

  constructor(options: {
    readonly policy: DaemonPolicyValues["output"];
    readonly directory?: string;
  }) {
    this.output = new OrderedCommandOutput(options);
  }

  appendRecord(record: LocalDaemonOutputRecord): Promise<void> {
    return this.output.appendRecord(record);
  }

  finish(exitCode: number): Promise<LocalDaemonExecutionResult> {
    return this.output.finish(exitCode);
  }

  dispose(): Promise<void> {
    return this.output.dispose();
  }
}
