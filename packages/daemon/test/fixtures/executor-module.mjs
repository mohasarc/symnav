class FixtureOutput {
  constructor(records) {
    this.outputRecords = records;
  }

  async *records() {
    yield* this.outputRecords;
  }

  dispose() {
    return Promise.resolve();
  }
}

class FixtureExecutor {
  constructor(options) {
    this.options = options;
  }

  async initialize(workspaceRoot) {
    if (workspaceRoot === "fail:initialize") throw new Error("fixture initialize failure");
    return {
      fileCount: workspaceRoot.startsWith("files:")
        ? Number.parseInt(workspaceRoot.slice("files:".length), 10)
        : 1,
    };
  }

  async execute(request) {
    if (request.argv[0] === "fail:execute") throw new Error("fixture execute failure");
    const records = request.argv.flatMap((instruction) => {
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

  async releaseTransientResources() {
    if (this.options.productVersion === "fail:release") {
      throw new Error("fixture release failure");
    }
    this.options.sampleResources();
  }
}

export function createDaemonExecutor(options) {
  return new FixtureExecutor(options);
}
