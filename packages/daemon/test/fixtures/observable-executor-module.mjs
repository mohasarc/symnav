import { appendFileSync } from "node:fs";
import { join } from "node:path";

class EmptyExecutorOutput {
  async *records() {}

  dispose() {
    return Promise.resolve();
  }
}

class ObservableExecutor {
  constructor(options) {
    this.options = options;
    this.record({
      kind: "create",
      stateDirectory: options.stateDirectory,
      productVersion: options.productVersion,
    });
  }

  initialize(workspaceRoot) {
    this.record({ kind: "initialize", workspaceRoot });
    return Promise.resolve({ fileCount: 1 });
  }

  execute() {
    return Promise.resolve({ exitCode: 0, output: new EmptyExecutorOutput() });
  }

  releaseTransientResources() {
    this.options.sampleResources();
    return Promise.resolve();
  }

  record(event) {
    appendFileSync(
      join(this.options.stateDirectory, "executor-events.jsonl"),
      `${JSON.stringify(event)}\n`,
    );
  }
}

export function createDaemonExecutor(options) {
  return new ObservableExecutor(options);
}
