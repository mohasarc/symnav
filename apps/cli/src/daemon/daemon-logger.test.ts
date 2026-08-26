import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeDaemonClock } from "./daemon-clock.js";
import {
  DAEMON_LOG_BACKUP_COUNT,
  DaemonLogger,
  type DaemonLogStorage,
} from "./daemon-logger.js";
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

  it("rotates before the byte limit and retains only four backups", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-rotation-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from("/repo", root);
    let now = 1;
    const logger = new DaemonLogger(
      identity,
      "rotation",
      { wallNowMs: () => now++, monotonicNowMs: () => 0 },
      { rotateBytes: 220 },
    );

    for (let index = 0; index < 12; index += 1) {
      logger.record({ kind: "ready", fileCount: index });
    }
    await logger.flush();

    const logFiles = readdirSync(identity.identityDirectory)
      .filter((name) => name.startsWith("daemon.log"))
      .sort();
    expect(logFiles).toEqual([
      "daemon.log",
      ...Array.from({ length: DAEMON_LOG_BACKUP_COUNT }, (_, index) => `daemon.log.${index + 1}`),
    ]);
    const retained = [...logFiles]
      .reverse()
      .flatMap((name) => readFileSync(join(identity.identityDirectory, name), "utf8").trim().split("\n"))
      .map((line) => JSON.parse(line) as { timestamp: number });
    expect(retained.map((event) => event.timestamp)).toEqual(
      [...retained].map((event) => event.timestamp).sort((left, right) => left - right),
    );
  });

  it("creates private diagnostic directories and files", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-permissions-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from("/repo", root);
    const logger = new DaemonLogger(identity, "permissions", new NodeDaemonClock());

    logger.record({ kind: "ready", fileCount: 1 });
    await logger.close();

    expect(statSync(identity.identityDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(identity.logPath).mode & 0o777).toBe(0o600);
  });

  it("reports dropped diagnostics after its bounded queue recovers", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-overflow-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from("/repo", root);
    const storage = new BlockingLogStorage();
    const logger = new DaemonLogger(identity, "overflow", new NodeDaemonClock(), {
      maximumQueuedEvents: 2,
      storage,
    });

    logger.record({ kind: "ready", fileCount: 1 });
    await storage.appendStarted;
    logger.record({ kind: "ready", fileCount: 2 });
    logger.record({ kind: "ready", fileCount: 3 });
    logger.record({ kind: "ready", fileCount: 4 });
    storage.release();
    await logger.flush();

    expect(storage.events().map((event) => event.kind)).toEqual([
      "ready",
      "ready",
      "ready",
      "diagnostics-dropped",
    ]);
    expect(storage.events().at(-1)).toMatchObject({ droppedCount: 1 });
  });

});

class BlockingLogStorage implements DaemonLogStorage {
  readonly appendStarted: Promise<void>;
  private resolveAppendStarted!: () => void;
  private releaseAppend!: () => void;
  private readonly gate: Promise<void>;
  private readonly lines: string[] = [];

  constructor() {
    this.appendStarted = new Promise((resolve) => {
      this.resolveAppendStarted = resolve;
    });
    this.gate = new Promise((resolve) => {
      this.releaseAppend = resolve;
    });
  }

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  size(): Promise<number> {
    return Promise.resolve(this.lines.reduce((total, line) => total + Buffer.byteLength(line), 0));
  }

  async append(_path: string, line: string): Promise<void> {
    this.resolveAppendStarted();
    await this.gate;
    this.lines.push(line);
  }

  move(): Promise<void> {
    return Promise.resolve();
  }

  remove(): Promise<void> {
    return Promise.resolve();
  }

  sync(): Promise<void> {
    return Promise.resolve();
  }

  release(): void {
    this.releaseAppend();
  }

  events(): readonly Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}
