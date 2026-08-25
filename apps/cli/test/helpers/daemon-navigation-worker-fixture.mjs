import { parentPort, workerData } from "node:worker_threads";
import { writeFileSync } from "node:fs";

const generation = 7;

parentPort.on("message", (message) => {
  if (message.kind === "initialize") {
    if (workerData.mode === "malformed") {
      parentPort.postMessage({ kind: "ready", generation, fileCount: "wrong" });
      return;
    }
    if (workerData.mode === "late-generation") {
      parentPort.postMessage({ kind: "closed", generation: generation - 1 });
    }
    if (workerData.mode === "block")
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    parentPort.postMessage({
      kind: "ready",
      generation,
      fileCount: 1,
      refresh: { added: 1, changed: 0, removed: 0, unchanged: 0 },
      startupDurations: { discoveryMs: 50, indexingMs: 100, totalMs: 150 },
    });
    return;
  }
  if (message.kind === "execute") {
    if (workerData.requestStartedPath !== undefined) {
      writeFileSync(workerData.requestStartedPath, "started");
    }
    if (workerData.mode === "block" || workerData.mode === "block-execution") {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.blockMs ?? 150);
    }
    const result = {
      kind: "result",
      generation,
      requestId: message.requestId,
      result: { frames: [], exitCode: 0 },
      refresh: { added: 0, changed: 0, removed: 0, unchanged: 1 },
      durations: { freshnessMs: 1, navigationMs: 149, renderMs: 0, outputMs: 0 },
    };
    parentPort.postMessage(result);
    if (workerData.mode === "duplicate") parentPort.postMessage(result);
    return;
  }
  if (message.kind === "release-transient") {
    parentPort.postMessage({ kind: "heap", generation, usedHeapBytes: 1, heapLimitBytes: 2 });
    return;
  }
  if (message.kind === "close") {
    parentPort.postMessage({ kind: "closed", generation });
    parentPort.close();
  }
});
