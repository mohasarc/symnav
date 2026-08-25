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

const telemetry = {
  symnavVersion: "0.1.0",
  command: "overview",
  timestamp: 1,
  durationMs: 2.5,
  executionMode: "warm",
  outcome: "success",
  argShape: { kind: "path", lengthBucket: "short", flags: ["--json"] },
  resultCounts: { symbols: 1 },
  workspaceId: "workspace",
  machineId: "machine",
} as const;

describe("DaemonNavigationWorkerProtocol", () => {
  it.each<DaemonNavigationWorkerRequest>([
    { kind: "initialize", generation: 4, workspaceRoot: "/repo" },
    { kind: "execute", generation: 4, requestId: "request-1", request },
    { kind: "release-transient", generation: 4 },
    { kind: "close", generation: 4 },
  ])("accepts correlated $kind requests", (message) => {
    expect(DaemonNavigationWorkerProtocol.request(message)).toEqual(message);
  });

  it.each<DaemonNavigationWorkerResponse>([
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
      result: {
        frames: [{ stream: "stdout", bytesBase64: "c3ltbmF2Cg==" }],
        exitCode: 0,
        telemetry,
      },
      refresh,
      durations: { freshnessMs: 1, navigationMs: 2, renderMs: 3, outputMs: 4 },
    },
    {
      kind: "failed",
      generation: 4,
      requestId: "request-1",
      failureCode: "execution",
      errorName: "Error",
    },
    {
      kind: "result",
      generation: 4,
      requestId: "request-user-error",
      result: {
        frames: [],
        exitCode: 1,
        telemetry: { ...telemetry, outcome: "user_error", errorReason: "missing target" },
      },
      refresh,
      durations: { freshnessMs: 1, navigationMs: 2, renderMs: 3, outputMs: 4 },
    },
    {
      kind: "result",
      generation: 4,
      requestId: "request-crash",
      result: {
        frames: [],
        exitCode: 1,
        telemetry: { ...telemetry, outcome: "crash", errorReason: "unexpected failure" },
      },
      refresh,
      durations: { freshnessMs: 1, navigationMs: 2, renderMs: 3, outputMs: 4 },
    },
    { kind: "heap", generation: 4, usedHeapBytes: 20, heapLimitBytes: 100 },
    { kind: "closed", generation: 4 },
  ])("accepts validated $kind responses", (message) => {
    expect(DaemonNavigationWorkerProtocol.response(message)).toEqual(message);
  });

  it.each([
    undefined,
    null,
    {},
    { kind: "initialize", generation: -1, workspaceRoot: "/repo" },
    { kind: "execute", generation: 1, requestId: "", request },
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
    { kind: "result", generation: 1, requestId: "one", result: { frames: [] } },
    { kind: "failed", generation: 1, failureCode: "unknown" },
    { kind: "heap", generation: 1, usedHeapBytes: -1, heapLimitBytes: 10 },
    { kind: "closed", generation: 1, extra: true },
  ])("rejects malformed worker responses %#", (message) => {
    expect(() => DaemonNavigationWorkerProtocol.response(message)).toThrow(/worker response/i);
  });

  it.each([
    resultWith({ frames: [{ stream: "stdout", bytesBase64: "%%%" }], exitCode: 0 }),
    resultWith({ frames: [{ stream: "stdout", bytesBase64: "Zh==" }], exitCode: 0 }),
    resultWith({ frames: [], exitCode: -1 }),
    resultWith({ frames: [], exitCode: 0, telemetry: {} }),
    resultWith({ frames: [], exitCode: 0, telemetry: { ...telemetry, timestamp: Infinity } }),
    resultWith({ frames: [], exitCode: 0, telemetry: { ...telemetry, durationMs: -1 } }),
    resultWith({
      frames: [],
      exitCode: 0,
      telemetry: { ...telemetry, argShape: { ...telemetry.argShape, kind: "other" } },
    }),
    resultWith({
      frames: [],
      exitCode: 0,
      telemetry: { ...telemetry, argShape: { ...telemetry.argShape, extra: true } },
    }),
    resultWith({
      frames: [],
      exitCode: 0,
      telemetry: { ...telemetry, resultCounts: { symbols: -1 } },
    }),
    resultWith({ frames: [], exitCode: 0, telemetry: { ...telemetry, extra: true } }),
    resultWith({
      frames: [],
      exitCode: 0,
      telemetry: { ...telemetry, outcome: "user_error" },
    }),
    resultWith({
      frames: [],
      exitCode: 0,
      telemetry: { ...telemetry, outcome: "success", errorReason: "unexpected" },
    }),
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
      result: { frames: [], exitCode: 0 },
      refresh: { ...refresh, added: 0.5 },
      durations: { freshnessMs: 1, navigationMs: 2, renderMs: 3, outputMs: 4 },
    },
  ])("rejects structurally invalid nested worker results %#", (message) => {
    expect(() => DaemonNavigationWorkerProtocol.response(message)).toThrow(/worker response/i);
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
  };
}
