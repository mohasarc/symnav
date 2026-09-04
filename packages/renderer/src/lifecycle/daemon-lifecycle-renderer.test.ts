import { describe, expect, it } from "vitest";
import { DaemonLifecycleRenderer } from "./daemon-lifecycle-renderer.js";
import type {
  DaemonStartResult,
  DaemonStopResult,
  RunningDaemonStatus,
} from "@symnav/daemon";

describe("DaemonLifecycleRenderer start", () => {
  it.each([
    [
      { status: "ready", workspaceRoot: "/repo", fileCount: 42, loadDurationMs: 999 },
      "Daemon ready for /repo\n42 files loaded in 999ms\n",
    ],
    [
      { status: "already-running", workspaceRoot: "/repo", pid: 17, uptimeMs: 60_000 },
      "Daemon already running for /repo (pid 17, up 1m)\n",
    ],
    [{ status: "disabled" }, "Daemon disabled by SYMNAV_DAEMON=0\n"],
  ] satisfies ReadonlyArray<readonly [DaemonStartResult, string]>)(
    "renders $result.status text exactly",
    (result, expected) => {
      expect(DaemonLifecycleRenderer.renderStartText(result)).toBe(expected);
    },
  );

  it.each([
    { status: "ready", workspaceRoot: "/repo", fileCount: 42, loadDurationMs: 1_000 },
    { status: "already-running", workspaceRoot: "/repo", pid: 17, uptimeMs: 3_600_000 },
    { status: "disabled" },
  ] satisfies readonly DaemonStartResult[])("renders $status JSON with one newline", (result) => {
    expect(DaemonLifecycleRenderer.renderStartJson(result)).toBe(`${JSON.stringify(result)}\n`);
  });

  it.each([
    [0, "0ms"],
    [999, "999ms"],
    [1_000, "1.0s"],
  ] as const)("renders load duration boundary %d as %s", (loadDurationMs, duration) => {
    expect(
      DaemonLifecycleRenderer.renderStartText({
        status: "ready",
        workspaceRoot: "/repo",
        fileCount: 1,
        loadDurationMs,
      }),
    ).toContain(`loaded in ${duration}\n`);
  });

  it.each([
    [999, "0s"],
    [1_000, "1s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [3_599_999, "59m"],
    [3_600_000, "1h"],
  ] as const)("renders uptime boundary %d as %s", (uptimeMs, uptime) => {
    expect(
      DaemonLifecycleRenderer.renderStartText({
        status: "already-running",
        workspaceRoot: "/repo",
        pid: 17,
        uptimeMs,
      }),
    ).toContain(`up ${uptime})\n`);
  });
});

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

  it("preserves input ordering", () => {
    const statuses: readonly RunningDaemonStatus[] = [
      {
        state: "ready",
        workspaceRoot: "/zeta",
        pid: 12,
        uptimeMs: 1_000,
        fileCount: 1,
        memoryBytes: 1,
      },
      { state: "starting", workspaceRoot: "/alpha", pid: 11, startupElapsedMs: 1_000 },
    ];

    expect(DaemonLifecycleRenderer.renderStatusText(statuses)).toBe(
      "/zeta  pid 12  up 1s  ready  1 files  1 B  no requests\n" + "/alpha  pid 11  starting 1s\n",
    );
  });

  it("renders optional status values when present", () => {
    const statuses: readonly RunningDaemonStatus[] = [
      {
        state: "starting",
        workspaceRoot: "/starting",
        pid: 11,
        startupElapsedMs: 2_400,
        memoryBytes: 1_536,
      },
      {
        state: "ready",
        workspaceRoot: "/ready",
        pid: 12,
        uptimeMs: 2_000,
        fileCount: 1,
        memoryBytes: 10_240,
        lastRequestAgoMs: 59_999,
      },
    ];

    expect(DaemonLifecycleRenderer.renderStatusText(statuses)).toBe(
      "/starting  pid 11  starting 2s  1.5 KB\n" +
        "/ready  pid 12  up 2s  ready  1 files  10 KB  last request 59s ago\n",
    );
  });

  it.each([
    [1_023, "1023 B"],
    [1_024, "1 KB"],
    [1_536, "1.5 KB"],
    [10_240, "10 KB"],
    [1_048_576, "1 MB"],
    [1_073_741_824, "1 GB"],
  ] as const)("renders byte boundary %d as %s", (memoryBytes, renderedBytes) => {
    expect(
      DaemonLifecycleRenderer.renderStatusText([
        {
          state: "ready",
          workspaceRoot: "/repo",
          pid: 12,
          uptimeMs: 0,
          fileCount: 1,
          memoryBytes,
        },
      ]),
    ).toContain(`  ${renderedBytes}  `);
  });

  it("renders an empty status collection exactly", () => {
    expect(DaemonLifecycleRenderer.renderStatusText([])).toBe("No daemons running.\n");
  });

  it("wraps status JSON bytes in a versioned envelope", () => {
    const statuses: readonly RunningDaemonStatus[] = [
      { state: "starting", workspaceRoot: "/repo", pid: 11, startupElapsedMs: 10 },
    ];

    expect(DaemonLifecycleRenderer.renderStatusJson(statuses)).toBe(
      `${JSON.stringify({ schemaVersion: 1, daemons: statuses })}\n`,
    );
  });
});

describe("DaemonLifecycleRenderer stop", () => {
  it.each([
    [{ status: "stopped", workspaceRoot: "/repo", pid: 17 }, "Stopped daemon for /repo (pid 17)\n"],
    [{ status: "killed", workspaceRoot: "/repo", pid: 17 }, "Killed daemon for /repo (pid 17)\n"],
    [{ status: "not-running", workspaceRoot: "/repo" }, "No daemon running for /repo\n"],
  ] satisfies ReadonlyArray<readonly [DaemonStopResult, string]>)(
    "renders $result.status text exactly",
    (result, expected) => {
      expect(DaemonLifecycleRenderer.renderStopText(result)).toBe(expected);
    },
  );

  it.each([
    { status: "stopped", workspaceRoot: "/repo", pid: 17 },
    { status: "killed", workspaceRoot: "/repo", pid: 17 },
    { status: "not-running", workspaceRoot: "/repo" },
  ] satisfies readonly DaemonStopResult[])("renders $status JSON with one newline", (result) => {
    expect(DaemonLifecycleRenderer.renderStopJson(result)).toBe(`${JSON.stringify(result)}\n`);
  });
});
