import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeDaemonClock } from "./daemon-clock.js";
import { DaemonLogger } from "./daemon-logger.js";
import type { DaemonDiagnosticEvent } from "./daemon-protocol.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

describe("DaemonLogger", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("writes ordered JSON lifecycle, request, freshness, and failure events", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-log-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from("/repo", root);
    let now = 10;
    const logger = new DaemonLogger(identity, "one", {
      wallNowMs: () => now,
      monotonicNowMs: () => now,
    });

    logger.record({ kind: "start" });
    now = 11;
    logger.record({ kind: "ready", fileCount: 2 });
    logger.record({ kind: "request", command: "refs", durationMs: 4, exitCode: 0 });
    logger.record({ kind: "freshness", added: 1, changed: 2, removed: 3, unchanged: 4 });
    logger.record({
      kind: "failure",
      operation: "request",
      failureCode: "internal",
      errorName: "Error",
    });
    logger.record({ kind: "stop", reason: "graceful" });
    await logger.flush();

    const events = readFileSync(identity.logPath, "utf8")
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

  it("silently ignores write failures", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", "/missing/parent");
    const logger = new DaemonLogger(identity, "one", {
      wallNowMs: () => 10,
      monotonicNowMs: () => 10,
    });
    expect(() => logger.record({ kind: "stop", reason: "idle" })).not.toThrow();
  });

  it("writes only closed diagnostic fields and hashed workspace correlation", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-redaction-"));
    roots.push(root);
    const secrets = [
      "--regex=CompanySecret",
      "/Users/private/repository",
      "PaymentProcessor::charge",
      "source output text",
      "endpoint-token-user-git-stack",
      "raw failure message",
    ];
    const identity = DaemonWorkspaceIdentity.from(secrets[1]!, root);
    const logger = new DaemonLogger(identity, "instance-one", new NodeDaemonClock());
    const malicious = {
      kind: "failure",
      operation: "request",
      failureCode: "internal",
      errorName: "UnknownError",
      argv: secrets[0],
      cwd: secrets[1],
      symbol: secrets[2],
      output: secrets[3],
      endpoint: secrets[4],
      message: secrets[5],
    } as unknown as DaemonDiagnosticEvent;

    logger.record(malicious);
    await logger.flush();

    const contents = readFileSync(identity.logPath, "utf8");
    for (const secret of secrets) expect(contents).not.toContain(secret);
    expect(JSON.parse(contents)).toEqual({
      schemaVersion: 1,
      timestamp: expect.any(Number),
      instanceId: "instance-one",
      workspaceKey: identity.workspaceKey,
      kind: "failure",
      operation: "request",
      failureCode: "internal",
      errorName: "UnknownError",
    });
  });
});
