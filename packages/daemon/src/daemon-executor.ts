import type { DaemonDiagnostics } from "./daemon-diagnostics.js";

export type DaemonExecutionMode = "cold" | "warm" | "fallback";
export type DaemonOutputStream = "stdout" | "stderr";

export interface DaemonExecutorRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly telemetryEnabled: boolean;
  readonly executionMode: DaemonExecutionMode;
}

export interface DaemonOutputRecord {
  readonly stream: DaemonOutputStream;
  readonly bytes: Uint8Array;
}

export interface DaemonSequencedOutputRecord extends DaemonOutputRecord {
  readonly sequence: number;
}

export interface DaemonOutputSink {
  append(record: DaemonSequencedOutputRecord): Promise<void>;
}

export interface DaemonExecutorOutput {
  records(): AsyncIterable<DaemonOutputRecord>;
  dispose(): Promise<void>;
}

export interface DaemonExecutorInitializationResult {
  readonly fileCount: number;
  readonly diagnostics?: DaemonDiagnostics;
}

export interface DaemonExecutorExecutionResult {
  readonly exitCode: number;
  readonly output: DaemonExecutorOutput;
  readonly diagnostics?: DaemonDiagnostics;
}

export interface DaemonExecutor {
  initialize(workspaceRoot: string): Promise<DaemonExecutorInitializationResult>;
  execute(request: DaemonExecutorRequest): Promise<DaemonExecutorExecutionResult>;
  releaseTransientResources(): Promise<void>;
}

export interface DaemonExecutorFactoryOptions {
  readonly stateDirectory: string;
  readonly productVersion: string;
}

export type DaemonExecutorFactory = (
  options: DaemonExecutorFactoryOptions,
) => DaemonExecutor | Promise<DaemonExecutor>;

export interface DaemonExecutorModule {
  readonly createDaemonExecutor: DaemonExecutorFactory;
}

export type DaemonExecutorModuleUrl = string;
