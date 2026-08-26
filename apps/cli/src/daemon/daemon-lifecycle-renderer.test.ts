import { describe, expect, it } from "vitest";
import { DaemonLifecycleRenderer } from "./daemon-lifecycle-renderer.js";
import type { RunningDaemonStatus } from "./daemon-protocol.js";

describe("DaemonLifecycleRenderer status", () => {
  it("renders explicit lifecycle fields without inventing unavailable metrics", () => {
    const statuses: readonly RunningDaemonStatus[] = [
      { state: "starting", workspaceRoot: "/starting", pid: 11, startupElapsedMs: 2_400 },
      {
        state: "busy",
        workspaceRoot: "/busy",
        pid: 12,
        uptimeMs: 5_000,
        command: "refs",
        elapsedMs: 1_200,
        queued: 2,
        memoryBytes: 4_194_304,
      },
      {
        state: "ready",
        workspaceRoot: "/ready",
        pid: 13,
        uptimeMs: 60_000,
        fileCount: 42,
        memoryBytes: 8_388_608,
      },
      {
        state: "recovering",
        workspaceRoot: "/recovering",
        pid: 14,
        uptimeMs: 8_000,
        detail: "worker-replacement",
        queued: 1,
        memoryBytes: 16_777_216,
      },
      { state: "unresponsive", workspaceRoot: "/silent", pid: 15, uptimeMs: 9_000 },
    ];

    expect(DaemonLifecycleRenderer.renderStatusText(statuses)).toBe(
      "/starting  pid 11  starting 2s\n" +
        "/busy  pid 12  up 5s  busy refs  1s  queued 2  4 MB\n" +
        "/ready  pid 13  up 1m  ready  42 files  8 MB  no requests\n" +
        "/recovering  pid 14  up 8s  recovering worker-replacement  queued 1  16 MB\n" +
        "/silent  pid 15  up 9s  unresponsive\n",
    );
    expect(DaemonLifecycleRenderer.renderStatusText(statuses)).not.toContain("0 files");
    expect(DaemonLifecycleRenderer.renderStatusText(statuses)).not.toContain("0 B");
  });

  it("wraps status JSON in a versioned envelope", () => {
    const statuses: readonly RunningDaemonStatus[] = [
      { state: "starting", workspaceRoot: "/repo", pid: 11, startupElapsedMs: 10 },
    ];

    expect(JSON.parse(DaemonLifecycleRenderer.renderStatusJson(statuses))).toEqual({
      schemaVersion: 1,
      daemons: statuses,
    });
  });
});
