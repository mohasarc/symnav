import { appendFileSync } from "node:fs";
import { join } from "node:path";

export function createDaemonExecutor(options) {
  if (options.productVersion === "factory-throw") throw new Error("factory failure");
  const eventsPath = join(options.stateDirectory, "executor-events.txt");

  return {
    async initialize() {
      if (options.productVersion === "initialize-throw") throw new Error("initialize failure");
      if (options.productVersion === "invalid-initialization") return { fileCount: -1 };
      if (options.productVersion === "invalid-diagnostics") {
        return { fileCount: 1, diagnostics: { invalid: undefined } };
      }
      return {
        fileCount: 37,
        diagnostics: {
          refresh: { added: 2, changed: 3, removed: 5, unchanged: 7 },
          durations: { discoveryMs: 11, indexingMs: 22 },
          nested: { future: [null, true, "opaque"] },
        },
      };
    },
    async execute() {
      if (options.productVersion === "invalid-execution") return { exitCode: -1 };
      options.sampleResources();
      return {
        exitCode: 0,
        output: {
          async *records() {
            yield { stream: "stdout", bytes: new Uint8Array(70_000).fill(65) };
            yield { stream: "stderr", bytes: new Uint8Array([66, 67]) };
          },
          async dispose() {
            appendFileSync(eventsPath, "dispose\n");
          },
        },
        diagnostics: {
          refresh: { added: 0, changed: 1, removed: 0, unchanged: 36 },
          durations: { freshnessMs: 3, navigationMs: 4, renderMs: 5 },
          nested: { future: [1, "opaque"] },
        },
      };
    },
    async releaseTransientResources() {
      appendFileSync(eventsPath, "release\n");
    },
  };
}
