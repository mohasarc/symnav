import { describe, expect, it } from "vitest";
import {
  DaemonNavigationWorkerProtocol,
  type DaemonNavigationWorkerRequest,
  type DaemonNavigationWorkerResponse,
} from "./daemon-navigation-worker-protocol.js";

const request = {
  argv: ["overview", "input.ts"],
  cwd: "/repo",
  telemetryEnabled: false,
} as const;

const refresh = { added: 1, changed: 0, removed: 0, unchanged: 2 } as const;

describe("DaemonNavigationWorkerProtocol", () => {
  it.each<DaemonNavigationWorkerRequest>([
    { kind: "initialize", generation: 4, workspaceRoot: "/repo" },
    { kind: "execute", generation: 4, requestId: "request-1", request },
    { kind: "output-ack", generation: 4, requestId: "request-1", sequence: 7 },
    { kind: "release-transient", generation: 4, operationId: "release-1" },
    { kind: "close", generation: 4 },
  ])("accepts correlated $kind requests", (message) => {
    expect(DaemonNavigationWorkerProtocol.request(message)).toEqual(message);
  });

  it.each<DaemonNavigationWorkerResponse>([
    {
      kind: "output-chunk",
      generation: 4,
      requestId: "request-1",
      sequence: 0,
      stream: "stdout",
      bytes: new Uint8Array([1, 2, 3]),
    },
    {
      kind: "ready",
      generation: 4,
      fileCount: 3,
      refresh,
      startupDurations: { discoveryMs: 1, indexingMs: 2, totalMs: 3 },
    },
    {
      kind: "result",
      generation: 4,
      requestId: "request-1",
      result: { exitCode: 0 },
      refresh,
      durations: { freshnessMs: 1, navigationMs: 2, renderMs: 3, outputMs: 4 },
      resources: {
        workerHeapUsedBytes: 20,
        peakWorkerHeapUsedBytes: 40,
        workerHeapLimitBytes: 100,
      },
    },
    {
      kind: "failed",
      generation: 4,
      requestId: "request-1",
      failureCode: "execution",
      errorName: "Error",
    },
    {
      kind: "heap",
      generation: 4,
      operationId: "release-1",
      usedHeapBytes: 20,
      heapLimitBytes: 100,
    },
    { kind: "closed", generation: 4 },
  ])("accepts validated $kind responses", (message) => {
    expect(DaemonNavigationWorkerProtocol.response(message, 64 * 1024)).toEqual(message);
  });

  it.each([
    undefined,
    null,
    {},
    { kind: "initialize", generation: -1, workspaceRoot: "/repo" },
    { kind: "execute", generation: 1, requestId: "", request },
    { kind: "output-ack", generation: 1, requestId: "one", sequence: -1 },
    { kind: "execute", generation: 1, requestId: "one", request: { argv: "overview" } },
    { kind: "unknown", generation: 1 },
  ])("rejects malformed worker requests %#", (message) => {
    expect(() => DaemonNavigationWorkerProtocol.request(message)).toThrow(/worker request/i);
  });

  it.each([
    undefined,
    null,
    {},
    { kind: "ready", generation: 1, fileCount: -1, refresh, startupDurations: {} },
    {
      kind: "output-chunk",
      generation: 1,
      requestId: "one",
      sequence: 0,
      stream: "stdout",
      bytes: new Uint8Array(64 * 1024 + 1),
    },
    { kind: "result", generation: 1, requestId: "one", result: {} },
    { kind: "failed", generation: 1, failureCode: "unknown" },
    {
      kind: "heap",
      generation: 1,
      operationId: "release-1",
      usedHeapBytes: -1,
      heapLimitBytes: 10,
    },
    { kind: "closed", generation: 1, extra: true },
  ])("rejects malformed worker responses %#", (message) => {
    expect(() => DaemonNavigationWorkerProtocol.response(message, 64 * 1024)).toThrow(
      /worker response/i,
    );
  });

  it.each([
    resultWith({ exitCode: -1 }),
    resultWith({ exitCode: 0, telemetry: {} }),
    {
      kind: "ready",
      generation: 1,
      fileCount: 1.5,
      refresh,
      startupDurations: { discoveryMs: 1, indexingMs: 2, totalMs: 3 },
    },
    {
      kind: "result",
      generation: 1,
      requestId: "one",
      result: { exitCode: 0 },
      refresh: { ...refresh, added: 0.5 },
      durations: { freshnessMs: 1, navigationMs: 2, renderMs: 3, outputMs: 4 },
    },
  ])("rejects structurally invalid nested worker results %#", (message) => {
    expect(() => DaemonNavigationWorkerProtocol.response(message, 64 * 1024)).toThrow(
      /worker response/i,
    );
  });
});

function resultWith(result: unknown): unknown {
  return {
    kind: "result",
    generation: 1,
    requestId: "one",
    result,
    refresh,
    durations: { freshnessMs: 1, navigationMs: 2, renderMs: 3, outputMs: 4 },
    resources: {
      workerHeapUsedBytes: 20,
      peakWorkerHeapUsedBytes: 40,
      workerHeapLimitBytes: 100,
    },
  };
}
