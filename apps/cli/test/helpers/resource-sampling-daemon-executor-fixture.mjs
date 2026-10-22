import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";

export function createDaemonExecutor(options) {
  return {
    async initialize() {
      return { fileCount: 1 };
    },
    async execute() {
      let retainedHeap = new Array(4_000_000).fill(7);
      options.sampleResources();
      retainedHeap = undefined;
      const garbageCollectionWasExposed = runInNewContext("typeof gc") === "function";
      try {
        setFlagsFromString("--expose-gc");
        if (options.productVersion === "collection-failure") throw new Error("collection failure");
        runInNewContext("gc")();
      } finally {
        setFlagsFromString(garbageCollectionWasExposed ? "--expose-gc" : "--no-expose-gc");
      }
      return {
        exitCode: 0,
        output: {
          async *records() {},
          async dispose() {},
        },
      };
    },
    async releaseTransientResources() {},
  };
}
