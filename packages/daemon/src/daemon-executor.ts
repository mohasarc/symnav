import { DaemonDiagnosticValues, type DaemonDiagnostics } from "./daemon-diagnostics.js";

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
  readonly sampleResources: () => void;
}

export type DaemonExecutorFactory = (
  options: DaemonExecutorFactoryOptions,
) => DaemonExecutor | Promise<DaemonExecutor>;

export interface DaemonExecutorModule {
  readonly createDaemonExecutor: DaemonExecutorFactory;
}

export type DaemonExecutorModuleUrl = string;

class ValidatedDaemonExecutorOutput implements DaemonExecutorOutput {
  constructor(private readonly output: DaemonExecutorOutput) {}

  async *records(): AsyncIterable<DaemonOutputRecord> {
    for await (const value of this.output.records()) {
      if (!DaemonExecutorValidation.isOutputRecord(value)) {
        throw new Error("Invalid daemon executor output record");
      }
      yield value;
    }
  }

  dispose(): Promise<void> {
    return this.output.dispose();
  }
}

class ValidatedDaemonExecutor implements DaemonExecutor {
  constructor(private readonly executor: DaemonExecutor) {}

  async initialize(workspaceRoot: string): Promise<DaemonExecutorInitializationResult> {
    const result: unknown = await this.executor.initialize(workspaceRoot);
    if (!DaemonExecutorValidation.isInitializationResult(result)) {
      throw new Error("Invalid daemon executor initialization result");
    }
    return result;
  }

  async execute(request: DaemonExecutorRequest): Promise<DaemonExecutorExecutionResult> {
    const result: unknown = await this.executor.execute(request);
    if (!DaemonExecutorValidation.isExecutionResult(result)) {
      throw new Error("Invalid daemon executor execution result");
    }
    return { ...result, output: new ValidatedDaemonExecutorOutput(result.output) };
  }

  releaseTransientResources(): Promise<void> {
    return this.executor.releaseTransientResources();
  }
}

export class DaemonExecutorModuleLoader {
  static async load(
    moduleUrl: DaemonExecutorModuleUrl,
    options: DaemonExecutorFactoryOptions,
  ): Promise<DaemonExecutor> {
    if (!DaemonExecutorValidation.isFileUrl(moduleUrl)) {
      throw new Error("Daemon executor module must use a file URL");
    }
    const loaded: unknown = await import(moduleUrl);
    if (
      !DaemonExecutorValidation.isRecord(loaded) ||
      typeof loaded.createDaemonExecutor !== "function"
    ) {
      throw new Error("Daemon executor module has no createDaemonExecutor factory");
    }
    const executor: unknown = await loaded.createDaemonExecutor(options);
    if (!DaemonExecutorValidation.isExecutor(executor)) {
      throw new Error("Daemon executor factory returned an invalid executor");
    }
    return new ValidatedDaemonExecutor(executor);
  }
}

class DaemonExecutorValidation {
  static isInitializationResult(value: unknown): value is DaemonExecutorInitializationResult {
    if (!this.isRecord(value)) return false;
    return (
      this.hasExactKeys(value, this.keysWithDiagnostics(["fileCount"], value)) &&
      this.isCount(value.fileCount) &&
      this.isDiagnostics(value.diagnostics)
    );
  }

  static isExecutionResult(value: unknown): value is DaemonExecutorExecutionResult {
    if (!this.isRecord(value)) return false;
    return (
      this.hasExactKeys(value, this.keysWithDiagnostics(["exitCode", "output"], value)) &&
      this.isCount(value.exitCode) &&
      this.isOutput(value.output) &&
      this.isDiagnostics(value.diagnostics)
    );
  }

  static isOutputRecord(value: unknown): value is DaemonOutputRecord {
    return (
      this.isRecord(value) &&
      this.hasExactKeys(value, ["stream", "bytes"]) &&
      (value.stream === "stdout" || value.stream === "stderr") &&
      value.bytes instanceof Uint8Array
    );
  }

  static isFileUrl(value: unknown): value is DaemonExecutorModuleUrl {
    return typeof value === "string" && value.startsWith("file://");
  }

  static isExecutor(value: unknown): value is DaemonExecutor {
    return (
      this.isRecord(value) &&
      typeof value.initialize === "function" &&
      typeof value.execute === "function" &&
      typeof value.releaseTransientResources === "function"
    );
  }

  private static isOutput(value: unknown): value is DaemonExecutorOutput {
    return (
      this.isRecord(value) &&
      typeof value.records === "function" &&
      typeof value.dispose === "function"
    );
  }

  private static isDiagnostics(value: unknown): value is DaemonDiagnostics | undefined {
    return value === undefined || DaemonDiagnosticValues.isDiagnostics(value);
  }

  private static keysWithDiagnostics(
    keys: readonly string[],
    value: Record<string, unknown>,
  ): readonly string[] {
    return value.diagnostics === undefined ? keys : [...keys, "diagnostics"];
  }

  private static hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length && actual.every((key, index) => key === expected[index])
    );
  }

  private static isCount(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
  }

  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
