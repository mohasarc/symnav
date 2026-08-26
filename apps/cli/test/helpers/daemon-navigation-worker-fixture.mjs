import { parentPort, workerData } from "node:worker_threads";
import { existsSync, writeFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";

const generation = 7;
let executionCount = 0;
const pendingResults = new Map();

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
    executionCount += 1;
    if (workerData.requestPayloadPath !== undefined) {
      writeFileSync(workerData.requestPayloadPath, JSON.stringify(message.request));
    }
    if (workerData.requestStartedPath !== undefined) {
      writeFileSync(workerData.requestStartedPath, "started");
      writeFileSync(`${workerData.requestStartedPath}.${executionCount}`, "started");
    }
    if (workerData.mode === "block" || workerData.mode === "block-execution") {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.blockMs ?? 150);
    }
    if (workerData.mode === "exit-on-release") {
      while (!existsSync(workerData.releasePath)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      throw new Error("intentional daemon navigation worker exit");
    }
    const result = {
      kind: "result",
      generation,
      requestId: message.requestId,
      result: { exitCode: 0 },
      refresh: { added: 0, changed: 0, removed: 0, unchanged: 1 },
      durations: { freshnessMs: 1, navigationMs: 149, renderMs: 0, outputMs: 0 },
    };
    pendingResults.set(message.requestId, result);
    const bytes = Uint8Array.from(Buffer.from("worker output\n"));
    parentPort.postMessage(
      {
        kind: "output-chunk",
        generation,
        requestId: message.requestId,
        sequence: 0,
        stream: "stdout",
        bytes,
      },
      [bytes.buffer],
    );
    return;
  }
  if (message.kind === "output-ack") {
    const result = pendingResults.get(message.requestId);
    if (result === undefined || message.sequence !== 0) throw new Error("unexpected output ack");
    pendingResults.delete(message.requestId);
    parentPort.postMessage(result);
    if (workerData.mode === "duplicate") parentPort.postMessage(result);
    return;
  }
  if (message.kind === "release-transient") {
    const heap = getHeapStatistics();
    parentPort.postMessage({
      kind: "heap",
      generation,
      usedHeapBytes: heap.used_heap_size,
      heapLimitBytes: heap.heap_size_limit,
    });
    return;
  }
  if (message.kind === "close") {
    parentPort.postMessage({ kind: "closed", generation });
    parentPort.close();
  }
});
