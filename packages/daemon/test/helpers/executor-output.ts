import type {
  DaemonExecutorExecutionResult,
  DaemonExecutorOutput,
  DaemonExecutorRequest,
  DaemonSequencedOutputRecord,
} from "../../src/daemon-executor.js";

export type CliExecutionRequest = DaemonExecutorRequest;
export type CommandOutputRecord = DaemonSequencedOutputRecord;

interface CommandOutput extends DaemonExecutorOutput {
  records(): AsyncIterable<CommandOutputRecord>;
}

export interface CommandExecutionResult extends DaemonExecutorExecutionResult {
  readonly output: CommandOutput;
}

export class CommandOutputSnapshot implements DaemonExecutorOutput {
  private readonly captured: readonly CommandOutputRecord[];

  constructor(records: readonly Omit<CommandOutputRecord, "sequence">[]) {
    this.captured = records.map((record, sequence) => ({ ...record, sequence }));
  }

  async *records(): AsyncIterable<CommandOutputRecord> {
    yield* this.captured;
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
