interface DaemonExecutorFactoryOptions {
  readonly stateDirectory: string;
  readonly productVersion: string;
  readonly sampleResources: () => void;
}

interface DaemonExecutorRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly telemetryEnabled: boolean;
  readonly executionMode: "cold" | "warm" | "fallback";
}

interface DaemonOutputRecord {
  readonly stream: "stdout" | "stderr";
  readonly bytes: Uint8Array;
}

interface DaemonExecutorOutput {
  records(): AsyncIterable<DaemonOutputRecord>;
  dispose(): Promise<void>;
}

interface DaemonExecutor {
  initialize(workspaceRoot: string): Promise<{ readonly fileCount: number }>;
  execute(request: DaemonExecutorRequest): Promise<{
    readonly exitCode: number;
    readonly output: DaemonExecutorOutput;
  }>;
  releaseTransientResources(): Promise<void>;
}

class FixtureOutput implements DaemonExecutorOutput {
  constructor(private readonly outputRecords: readonly DaemonOutputRecord[]) {}

  async *records(): AsyncIterable<DaemonOutputRecord> {
    yield* this.outputRecords;
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class FixtureExecutor implements DaemonExecutor {
  private released = false;

  constructor(private readonly options: DaemonExecutorFactoryOptions) {}

  async initialize(workspaceRoot: string): Promise<{ readonly fileCount: number }> {
    if (workspaceRoot === "fail:initialize") throw new Error("fixture initialize failure");
    const fileCount = workspaceRoot.startsWith("files:")
      ? Number.parseInt(workspaceRoot.slice("files:".length), 10)
      : 1;
    return { fileCount };
  }

  async execute(request: DaemonExecutorRequest): Promise<{
    readonly exitCode: number;
    readonly output: DaemonExecutorOutput;
  }> {
    if (request.argv[0] === "fail:execute") throw new Error("fixture execute failure");
    const records = request.argv.flatMap((instruction): readonly DaemonOutputRecord[] => {
      const separator = instruction.indexOf(":");
      const kind = instruction.slice(0, separator);
      const value = instruction.slice(separator + 1);
      if (kind !== "stdout" && kind !== "stderr") return [];
      return [{ stream: kind, bytes: Buffer.from(value) }];
    });
    const exitInstruction = request.argv.find((instruction) => instruction.startsWith("exit:"));
    return {
      exitCode:
        exitInstruction === undefined
          ? 0
          : Number.parseInt(exitInstruction.slice("exit:".length), 10),
      output: new FixtureOutput(records),
    };
  }

  async releaseTransientResources(): Promise<void> {
    if (this.options.productVersion === "fail:release") {
      throw new Error("fixture release failure");
    }
    this.released = true;
    this.options.sampleResources();
  }

  isReleased(): boolean {
    return this.released;
  }
}

export function createDaemonExecutor(options: DaemonExecutorFactoryOptions): DaemonExecutor {
  return new FixtureExecutor(options);
}
