import type { CommandOutputRecord, CommandOutputSummary } from "../command-execution-result.js";

export const COMMAND_OUTPUT_CHUNK_BYTES = 64 * 1024;
export const DAEMON_MAXIMUM_CONTROL_FRAME_BYTES = 256 * 1024;
export const COMMAND_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;
export const DAEMON_COMPLETION_SPOOL_LIMIT_BYTES = 512 * 1024 * 1024;
export const COMPLETION_SPOOL_INLINE_BYTES = 256 * 1024;

export interface CompletionSpoolIdentity {
  readonly workspaceKey: string;
  readonly instanceId: string;
  readonly transferId: string;
}

export interface CompletionSpoolManifest extends CommandOutputSummary {
  readonly transferId: string;
  readonly requestId: string;
  readonly instanceId: string;
  readonly exitCode: number;
}

export interface CompletionSpoolUsage {
  readonly rawBytes: number;
  readonly completionCount: number;
}

export interface DaemonCompletionSpoolStoreOptions {
  readonly directory: string;
  readonly workspaceKey: string;
  readonly instanceId: string;
  readonly inlineBytes?: number;
  readonly maximumResultBytes?: number;
  readonly maximumAggregateBytes?: number;
}

export class CompletionSpoolCapacityError extends Error {
  constructor() {
    super("Daemon completion spool capacity exceeded");
    this.name = "CompletionSpoolCapacityError";
  }
}

export class CompletionSpool {
  append(_record: CommandOutputRecord): Promise<void> {
    throw new Error("Completion spool is not implemented");
  }

  finish(_exitCode: number): Promise<CompletionSpoolManifest> {
    throw new Error("Completion spool is not implemented");
  }

  read(_offset: number): AsyncIterable<CommandOutputRecord> {
    throw new Error("Completion spool is not implemented");
  }

  acknowledge(): Promise<void> {
    throw new Error("Completion spool is not implemented");
  }

  dispose(): Promise<void> {
    throw new Error("Completion spool is not implemented");
  }
}

export class DaemonCompletionSpoolStore {
  constructor(_options: DaemonCompletionSpoolStoreOptions) {}

  create(_requestId: string): Promise<CompletionSpool> {
    throw new Error("Completion spool is not implemented");
  }

  open(_requestId: string): Promise<CompletionSpool | undefined> {
    throw new Error("Completion spool is not implemented");
  }

  usage(): CompletionSpoolUsage {
    throw new Error("Completion spool is not implemented");
  }

  cleanupInstance(_instanceId: string): Promise<void> {
    throw new Error("Completion spool is not implemented");
  }

  cleanupConfirmedDeadInstance(_instanceId: string): Promise<void> {
    throw new Error("Completion spool is not implemented");
  }
}
