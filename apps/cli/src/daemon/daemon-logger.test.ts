import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import { NodeDaemonClock } from "./daemon-clock.js";
import { DAEMON_LOG_BACKUP_COUNT, DaemonLogger, type DaemonLogStorage } from "./daemon-logger.js";
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

  it("rejects open string values in otherwise allowed diagnostic fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-closed-values-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from("/repo", root);
    const logger = new DaemonLogger(identity, "instance-one", new NodeDaemonClock());
    const secret = "CustomerSourceSymbol";

    for (const event of [
      { kind: "failure", operation: secret, failureCode: "internal", errorName: "Error" },
      { kind: "failure", operation: "request", failureCode: secret, errorName: "Error" },
      { kind: "execution-terminal", requestId: "request", outcome: secret, serviceMs: 1 },
      { kind: "stop", reason: secret },
      {
        kind: "worker-replaced",
        cause: secret,
        previousWorkerGeneration: 1,
        workerGeneration: 2,
        fileCount: 1,
        discoveryMs: 0,
        indexingMs: 1,
        totalMs: 1,
      },
    ]) {
      logger.record(event as unknown as DaemonDiagnosticEvent);
    }
    logger.record({ kind: "start" });
    await logger.flush();

    const contents = readFileSync(identity.logPath, "utf8");
    expect(contents).not.toContain(secret);
    expect(contents.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(contents)).toMatchObject({ kind: "start" });
  });

  it("persists only closed process termination classifications", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-termination-log-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from("/repo", root);
    const logger = new DaemonLogger(identity, "instance-one", new NodeDaemonClock());

    logger.record({
      kind: "process-termination",
      terminationReason: "signal",
      signal: "SIGTERM",
    });
    logger.record({
      kind: "process-termination",
      terminationReason: "unhandled-rejection",
      errorName: "TypeError",
    });
    logger.record({
      kind: "process-termination",
      terminationReason: "open-secret",
      signal: "SECRET_SIGNAL",
    } as unknown as DaemonDiagnosticEvent);
    await logger.flush();

    const events = readFileSync(identity.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "process-termination",
        terminationReason: "signal",
        signal: "SIGTERM",
      }),
      expect.objectContaining({
        kind: "process-termination",
        terminationReason: "unhandled-rejection",
        errorName: "TypeError",
      }),
    ]);
  });

  it("writes opaque fixed-size request correlation instead of caller identifiers", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-request-correlation-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from("/repo", root);
    const logger = new DaemonLogger(identity, "instance-one", new NodeDaemonClock());
    const sourceShapedRequestId = "/private/source/PaymentProcessor::charge?token=secret";

    logger.record({
      kind: "request-accepted",
      requestId: sourceShapedRequestId,
      command: "refs",
      queueDepth: 0,
      workerGeneration: 1,
    });
    logger.record({
      kind: "turn-started",
      requestId: sourceShapedRequestId,
      queueWaitMs: 1,
      workerGeneration: 1,
    });
    logger.record({
      kind: "request-accepted",
      requestId: "different-request",
      command: "refs",
      queueDepth: 0,
      workerGeneration: 1,
    });
    await logger.flush();

    const contents = readFileSync(identity.logPath, "utf8");
    const events = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { requestId: string });
    expect(contents).not.toContain(sourceShapedRequestId);
    expect(events.map((event) => event.requestId)).toEqual([
      expect.stringMatching(/^[a-f\d]{64}$/),
      events[0]?.requestId,
      expect.stringMatching(/^[a-f\d]{64}$/),
    ]);
    expect(events[2]?.requestId).not.toBe(events[0]?.requestId);
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
      .flatMap((name) =>
        readFileSync(join(identity.identityDirectory, name), "utf8").trim().split("\n"),
      )
      .map((line) => JSON.parse(line) as { timestamp: number });
    expect(retained.map((event) => event.timestamp)).toEqual(
      [...retained].map((event) => event.timestamp).sort((left, right) => left - right),
    );
  });

  it("creates diagnostic directories and files", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-permissions-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from("/repo", root);
    const logger = new DaemonLogger(identity, "permissions", new NodeDaemonClock());

    logger.record({ kind: "ready", fileCount: 1 });
    await logger.close();

    expect(statSync(identity.identityDirectory).isDirectory()).toBe(true);
    expect(statSync(identity.logPath).isFile()).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "creates private POSIX diagnostic directories and files",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "symnav-daemon-permissions-"));
      roots.push(root);
      const identity = DaemonWorkspaceIdentity.from("/repo", root);
      const logger = new DaemonLogger(identity, "permissions", new NodeDaemonClock());

      logger.record({ kind: "ready", fileCount: 1 });
      await logger.close();

      expect(statSync(identity.identityDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(identity.logPath).mode & 0o777).toBe(0o600);
    },
  );

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

  it("uses the required diagnostic-policy queue capacity", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-policy-overflow-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from("/repo", root);
    const storage = new BlockingLogStorage();
    const policy = DaemonPolicyTestFactory.withOverrides(
      DaemonPolicy.fromSystemMemory({ totalBytes: 1024 ** 3 }),
      { diagnostics: { maximumQueuedEvents: 1 } },
    );
    const logger = new DaemonLogger(identity, "overflow", new NodeDaemonClock(), {
      policy: policy.values.diagnostics,
      storage,
    } as unknown as ConstructorParameters<typeof DaemonLogger>[3]);

    logger.record({ kind: "ready", fileCount: 1 });
    await storage.appendStarted;
    logger.record({ kind: "ready", fileCount: 2 });
    logger.record({ kind: "ready", fileCount: 3 });
    storage.release();
    await logger.flush();

    expect(storage.events().map((event) => event.kind)).toEqual([
      "ready",
      "ready",
      "diagnostics-dropped",
    ]);
  });

  it("isolates append and rotation failures from records and flush", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-failure-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from("/repo", root);
    const logger = new DaemonLogger(identity, "failure", new NodeDaemonClock(), {
      rotateBytes: 1,
      storage: new FailingLogStorage(),
    });

    expect(() => logger.record({ kind: "ready", fileCount: 1 })).not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();
    await expect(logger.close()).resolves.toBeUndefined();
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

class FailingLogStorage implements DaemonLogStorage {
  prepare(): Promise<void> {
    return Promise.reject(new Error("prepare failed"));
  }

  size(): Promise<number> {
    return Promise.resolve(2);
  }

  append(): Promise<void> {
    return Promise.reject(new Error("append failed"));
  }

  move(): Promise<void> {
    return Promise.reject(new Error("rotation failed"));
  }

  remove(): Promise<void> {
    return Promise.reject(new Error("remove failed"));
  }

  sync(): Promise<void> {
    return Promise.reject(new Error("sync failed"));
  }
}
