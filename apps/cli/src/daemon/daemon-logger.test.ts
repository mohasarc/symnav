import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonLogger } from "./daemon-logger.js";

describe("DaemonLogger", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("writes ordered JSON lifecycle, request, freshness, and failure events", () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-log-"));
    roots.push(root);
    const logPath = join(root, "workspace.log");
    let now = 10;
    const logger = new DaemonLogger(logPath, { now: () => now });

    logger.record({ kind: "start", workspaceRoot: "/repo", instanceId: "one" });
    now = 11;
    logger.record({ kind: "ready", fileCount: 2 });
    logger.record({ kind: "request", command: "refs", durationMs: 4, exitCode: 0 });
    logger.record({ kind: "freshness", added: 1, changed: 2, removed: 3, unchanged: 4 });
    logger.record({ kind: "failure", operation: "request", message: "boom" });
    logger.record({ kind: "stop", reason: "graceful" });

    const events = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; timestamp: number });
    expect(events.map((event) => event.kind)).toEqual([
      "start",
      "ready",
      "request",
      "freshness",
      "failure",
      "stop",
    ]);
    expect(events.map((event) => event.timestamp)).toEqual([10, 11, 11, 11, 11, 11]);
  });
});
