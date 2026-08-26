import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalStateDir } from "@symnav/telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonController } from "./daemon-controller.js";
import { DaemonStartupCoordinator } from "./daemon-startup-coordinator.js";
import {
  DaemonProcessTerminationError,
  NodeDaemonProcessTerminator,
  type DaemonProcess,
  type DaemonProcessExit,
  type DaemonProcessLauncher,
  type DaemonProcessTerminator,
} from "./daemon-process-launcher.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-protocol.js";
import { DAEMON_STARTUP_TIMEOUT_MS, DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { type DaemonExecutionReceipt, LocalDaemonTransport } from "./local-daemon-transport.js";

describe("DaemonStartupCoordinator", () => {
  const roots: string[] = [];
  const realProcessIds: number[] = [];

  afterEach(async () => {
    const terminator = new NodeDaemonProcessTerminator(100, 5);
    for (const pid of realProcessIds) {
      if (terminator.isAlive(pid)) await terminator.terminate(pid);
    }
    realProcessIds.length = 0;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("returns concurrent warm-up triggers after electing one detached child", async () => {
    const readinessGate = new ReadinessPublicationGate();
    const harness = new CoordinatorHarness(roots, { readinessPublicationGate: readinessGate });
    const firstCoordinator = harness.coordinator();
    const secondCoordinator = harness.coordinator();

    const [first, second] = await Promise.all([
      firstCoordinator.trigger(harness.identity),
      secondCoordinator.trigger(harness.identity),
    ]);

    expect(harness.launcher.launchCount).toBe(1);
    expect([first.status, second.status].sort()).toEqual(["launched", "starting"]);
    expect(first.instanceId).toBe(second.instanceId);
    expect(first.pid).toBe(second.pid);
    expect(harness.registry.startupOwner(harness.identity)).toMatchObject({
      ownerKind: "daemon",
      ownerPid: first.pid,
    });
    readinessGate.release();
  });

  it("retries for a caller already waiting on another coordinator's failed child", async () => {
    const harness = new CoordinatorHarness(roots, { exitingLaunches: 1 });
    const initiatingCoordinator = harness.coordinator();
    const waitingCoordinator = harness.coordinator();

    await expect(initiatingCoordinator.trigger(harness.identity)).resolves.toMatchObject({
      status: "launched",
    });

    await expect(waitingCoordinator.ensureRunning(harness.identity)).resolves.toMatchObject({
      status: "ready",
    });

    expect(harness.launcher.launchCount).toBe(2);
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
  });

  it("shares one readiness record without a healthy startup deadline", async () => {
    const readinessGate = new ReadinessPublicationGate();
    const harness = new CoordinatorHarness(roots, { readinessPublicationGate: readinessGate });
    const coordinator = harness.coordinator({ startupTimeoutMs: 5 });
    const trigger = await coordinator.trigger(harness.identity);
    const firstWait = coordinator.waitUntilReady(harness.identity);
    const secondWait = harness
      .coordinator({ startupTimeoutMs: 5 })
      .waitUntilReady(harness.identity);
    let settled = false;
    void Promise.all([firstWait, secondWait]).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(settled).toBe(false);
    expect(harness.registry.read(harness.identity)).toMatchObject({
      instanceId: trigger.instanceId,
      pid: trigger.pid,
      state: "starting",
    });

    readinessGate.release();
    await expect(Promise.all([firstWait, secondWait])).resolves.toEqual([
      expect.objectContaining({ status: "ready" }),
      expect.objectContaining({ status: "already-running" }),
    ]);
  });

  it("concurrent starts launch one daemon and report ready then already running", async () => {
    const harness = new CoordinatorHarness(roots);

    const [first, second] = await Promise.all([
      harness.coordinator().ensureRunning(harness.identity),
      harness.coordinator().ensureRunning(harness.identity),
    ]);

    expect(harness.launcher.launchCount).toBe(1);
    expect([first.status, second.status].sort()).toEqual(["already-running", "ready"]);
    expect(harness.registry.list()).toHaveLength(1);
  });

  it("keeps waiting for its live child after a transient ready-record probe failure", async () => {
    const harness = new CoordinatorHarness(roots, { readyAuthenticationFailures: 1 });

    await expect(
      harness.coordinator({ startupTimeoutMs: 1_000 }).ensureRunning(harness.identity),
    ).resolves.toMatchObject({ status: "ready", workspaceRoot: "/repo" });

    expect(harness.launcher.launchCount).toBe(1);
    expect(harness.registry.readStored(harness.identity)).toMatchObject({
      pid: harness.launcher.lastPid,
      state: "ready",
    });
  });

  it("keeps a later caller waiting through a transient missing startup owner", async () => {
    const readinessGate = new ReadinessPublicationGate();
    const harness = new CoordinatorHarness(roots, { readinessPublicationGate: readinessGate });
    const trigger = await harness.coordinator().trigger(harness.identity);
    const laterCoordinator = harness.coordinator();
    const startupOwner = harness.registry.startupOwner.bind(harness.registry);
    let missingOwnerReads = 0;
    vi.spyOn(harness.registry, "startupOwner").mockImplementation((identity) => {
      missingOwnerReads += 1;
      if (missingOwnerReads <= 3) {
        if (missingOwnerReads === 3) readinessGate.release();
        return undefined;
      }
      return startupOwner(identity);
    });

    const ready = laterCoordinator.waitUntilReady(harness.identity);

    await expect(ready).resolves.toMatchObject({
      status: "already-running",
      workspaceRoot: "/repo",
      pid: trigger.pid,
    });
    expect(harness.launcher.launchCount).toBe(1);
    expect(missingOwnerReads).toBeGreaterThanOrEqual(3);
  });

  it("bounds a persistent missing startup owner by the registry mutation grace", async () => {
    const harness = new CoordinatorHarness(roots);
    const startingRecord: DaemonRecord = {
      ...harness.readyRecord("missing-owner", harness.launcher.symnavVersion, 6001),
      state: "starting" as const,
    };
    harness.registry.write(startingRecord);
    let now = 0;

    await expect(
      harness
        .coordinator({
          now: () => {
            now += DAEMON_STARTUP_TIMEOUT_MS;
            return now;
          },
        })
        .waitUntilReady(harness.identity),
    ).rejects.toThrow("Daemon startup failed before readiness");

    expect(now).toBeGreaterThan(DAEMON_STARTUP_TIMEOUT_MS);
    expect(harness.launcher.launchCount).toBe(0);
  });

  it("rechecks readiness when publication releases startup ownership between reads", async () => {
    const readinessGate = new ReadinessPublicationGate();
    const harness = new CoordinatorHarness(roots, { readinessPublicationGate: readinessGate });
    const coordinator = harness.coordinator();
    await coordinator.trigger(harness.identity);
    const startingRecord = harness.registry.readStored(harness.identity)!;
    const originalReadStored = harness.registry.readStored.bind(harness.registry);
    vi.spyOn(harness.registry, "read").mockReturnValueOnce(startingRecord);
    vi.spyOn(harness.registry, "readStored").mockImplementationOnce((identity) => {
      const readyRecord: DaemonRecord = {
        ...startingRecord,
        state: "ready",
        readyAt: Date.now(),
        fileCount: 2,
      };
      expect(harness.registry.writeIfStartupOwner(identity, readyRecord)).toBe(true);
      harness.registry.removeStartupLockIfProcess(identity, readyRecord);
      return originalReadStored(identity);
    });

    await expect(coordinator.waitUntilReady(harness.identity)).resolves.toMatchObject({
      status: "ready",
      workspaceRoot: "/repo",
    });

    expect(harness.launcher.launchCount).toBe(1);
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
    expect(harness.registry.readStored(harness.identity)?.state).toBe("ready");
    readinessGate.release();
  });

  it("does not report an earlier child exit against a replacement startup", async () => {
    const harness = new CoordinatorHarness(roots, {
      neverReady: true,
      childExit: { code: 17, signal: null, cause: "exit" },
      childExitDelayMs: 5,
    });
    const coordinator = harness.coordinator();
    await coordinator.trigger(harness.identity);
    await waitUntil(() => harness.registry.readStored(harness.identity) === undefined);
    const replacement = harness.readyRecord(
      "replacement",
      harness.launcher.symnavVersion,
      process.pid,
    );
    const lease = harness.registry.acquireStartup(harness.identity, replacement.instanceId)!;
    harness.registry.write({ ...replacement, state: "starting" });

    const ready = coordinator.waitUntilReady(harness.identity);
    setTimeout(() => {
      harness.registry.write(replacement);
      lease.release();
    }, 5);

    await expect(ready).resolves.toMatchObject({
      status: "already-running",
      pid: process.pid,
    });
  });

  it("reuses a validated daemon running the same version", async () => {
    const harness = new CoordinatorHarness(roots);
    harness.seedReady("existing", "0.1.0", 4001);

    const result = await harness.coordinator().ensureRunning(harness.identity);

    expect(result.status).toBe("already-running");
    expect(harness.launcher.launchCount).toBe(0);
  });

  it("drains a validated daemon running a different version", async () => {
    const harness = new CoordinatorHarness(roots);
    harness.seedReady("existing", "0.0.9", 4002);

    const result = await harness.coordinator().ensureRunning(harness.identity);

    expect(harness.transport.terminationCount).toBe(1);
    expect(harness.terminator.terminated).not.toContain(4002);
    expect(harness.launcher.launchCount).toBe(1);
    expect(result.status).toBe("ready");
    expect(harness.registry.list()).toHaveLength(1);
  });

  it("retains ownership when a stale record references an unrelated live process", async () => {
    const oldPid = await spawnIdleProcess(realProcessIds);
    const runtime = socketBackedCoordinator(roots);
    runtime.registry.write(readyRecord(runtime.identity, "old", "old-process", oldPid));

    await expect(runtime.coordinator.ensureRunning(runtime.identity)).rejects.toThrow(
      /live but unresponsive/i,
    );

    expect(runtime.terminator.isAlive(oldPid)).toBe(true);
    expect(runtime.registry.list()).toHaveLength(1);
    expect(runtime.registry.readStored(runtime.identity)?.instanceId).toBe("old");
  });

  it.each(["schema", "protocol", "symnav"] as const)(
    "proves and replaces a real daemon for $mismatch mismatch",
    async (mismatch) => {
      const runtime = socketBackedCoordinator(roots);
      const oldPid = await spawnIdentifiableDaemon(
        runtime.identity,
        "old",
        "old-process",
        10,
        realProcessIds,
      );
      const oldRecord = readyRecord(runtime.identity, "old", "old-process", oldPid);
      const incompatibleRecord: DaemonRecord = {
        ...oldRecord,
        schemaVersion:
          mismatch === "schema" ? DAEMON_RECORD_SCHEMA_VERSION + 1 : oldRecord.schemaVersion,
        protocolVersion:
          mismatch === "protocol" ? DAEMON_PROTOCOL_VERSION + 1 : oldRecord.protocolVersion,
        symnavVersion: mismatch === "symnav" ? "0.0.9" : "0.1.0",
      };
      runtime.registry.write(incompatibleRecord);

      const result = await runtime.coordinator.ensureRunning(runtime.identity);

      expect(result.status).toBe("ready");
      await waitUntil(() => !runtime.terminator.isAlive(oldPid));
      expect(runtime.registry.list()).toHaveLength(1);
      expect(runtime.registry.read(runtime.identity)?.instanceId).not.toBe("old");
      await runtime.launcher.close();
    },
    10_000,
  );

  it("cleans startup state when process launch fails", async () => {
    const harness = new CoordinatorHarness(roots, { launchFailure: new Error("spawn failed") });

    await expect(harness.coordinator().ensureRunning(harness.identity)).rejects.toThrow(
      "spawn failed",
    );

    expect(harness.registry.readStored(harness.identity)).toBeUndefined();
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
  });

  it("does not launch a replacement until the authenticated daemon process exits", async () => {
    const harness = new CoordinatorHarness(roots, { oldDaemonExitsAfterTerminate: false });
    harness.seedReady("existing", "0.0.9", 4003);

    const starting = harness
      .coordinator({ startupTimeoutMs: 1_000 })
      .ensureRunning(harness.identity);
    await waitUntil(() => harness.transport.terminationCount === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.launcher.launchCount).toBe(0);
    expect(harness.registry.readStored(harness.identity)?.instanceId).toBe("existing");

    harness.terminator.alive.delete(4003);
    await expect(starting).resolves.toMatchObject({ status: "ready" });
    expect(harness.launcher.launchCount).toBe(1);
  });

  it("preserves termination failure precedence and startup ownership when the process stays alive", async () => {
    const harness = new CoordinatorHarness(roots, {
      launchFailure: new Error("replacement launch must remain blocked"),
      oldDaemonExitsAfterTerminate: false,
    });
    harness.seedReady("existing", "0.0.9", 4004);

    await expect(
      harness.coordinator({ terminationTimeoutMs: 5 }).ensureRunning(harness.identity),
    ).rejects.toBeInstanceOf(DaemonProcessTerminationError);

    expect(harness.launcher.launchCount).toBe(0);
    expect(harness.registry.readStored(harness.identity)?.instanceId).toBe("existing");
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
  });

  it("keeps replacement termination bounded when readiness has no default deadline", async () => {
    const harness = new CoordinatorHarness(roots, { oldDaemonExitsAfterTerminate: false });
    harness.seedReady("existing", "0.0.9", 4005);
    let elapsedMs = 0;

    await expect(
      harness
        .coordinator({
          now: () => {
            elapsedMs += 300_001;
            return elapsedMs;
          },
        })
        .ensureRunning(harness.identity),
    ).rejects.toBeInstanceOf(DaemonProcessTerminationError);

    expect(harness.launcher.launchCount).toBe(0);
    expect(harness.registry.readStored(harness.identity)?.instanceId).toBe("existing");
  }, 1_000);

  it("returns after launching a healthy daemon that is still warming", async () => {
    const harness = new CoordinatorHarness(roots, { neverReady: true });

    await expect(harness.coordinator().trigger(harness.identity)).resolves.toMatchObject({
      status: "launched",
    });

    expect(harness.terminator.terminated).not.toContain(harness.launcher.lastPid);
    expect(harness.registry.readStored(harness.identity)?.pid).toBe(harness.launcher.lastPid);
    expect(harness.registry.startupOwner(harness.identity)).toMatchObject({ ownerKind: "daemon" });
  });

  it("retains one live daemon warm-up after the launcher heartbeat expires", async () => {
    const harness = new CoordinatorHarness(roots, { neverReady: true });

    await harness.coordinator().trigger(harness.identity);
    const originalRecord = harness.registry.readStored(harness.identity);
    const originalOwner = harness.registry.startupOwner(harness.identity);
    expect(originalRecord?.pid).toBe(harness.launcher.lastPid);
    expect(originalOwner).toBeDefined();
    writeFileSync(
      harness.identity.startupOwnerPath(harness.identity.lockPath),
      JSON.stringify({ ...originalOwner, heartbeatAt: Date.now() - 60_000 }),
    );
    harness.terminator.currentProcessIsAlive = false;

    await expect(harness.coordinator().trigger(harness.identity)).resolves.toMatchObject({
      status: "starting",
      instanceId: originalRecord?.instanceId,
    });

    expect(harness.launcher.launchCount).toBe(1);
    expect(harness.registry.readStored(harness.identity)).toEqual(originalRecord);
  });

  it("lets a later caller use the original warm-up after the initiating caller exits", async () => {
    const readinessPublicationGate = new ReadinessPublicationGate();
    const harness = new CoordinatorHarness(roots, { readinessPublicationGate });

    await harness.coordinator().trigger(harness.identity);
    const originalRecord = harness.registry.readStored(harness.identity);
    expect(originalRecord?.pid).toBe(harness.launcher.lastPid);
    harness.terminator.currentProcessIsAlive = false;

    const laterCaller = harness
      .coordinator({ startupTimeoutMs: 1_000 })
      .ensureRunning(harness.identity);
    readinessPublicationGate.release();

    await expect(laterCaller).resolves.toMatchObject({
      status: "already-running",
      workspaceRoot: "/repo",
      pid: originalRecord?.pid,
    });
    expect(harness.launcher.launchCount).toBe(1);
    expect(harness.registry.readStored(harness.identity)?.instanceId).toBe(
      originalRecord?.instanceId,
    );
  });

  it("reports its launched child's exit after startup cleanup removes the record", async () => {
    const harness = new CoordinatorHarness(roots, {
      neverReady: true,
      childExit: { code: 17, signal: null, cause: "exit" },
      childExitDelayMs: 5,
    });
    const coordinator = harness.coordinator({ startupTimeoutMs: 1_000 });
    const startedAt = Date.now();

    await coordinator.trigger(harness.identity);
    await waitUntil(
      () =>
        harness.registry.readStored(harness.identity) === undefined &&
        harness.registry.startupOwner(harness.identity) === undefined,
    );

    await expect(coordinator.waitUntilReady(harness.identity)).rejects.toThrow(
      "Daemon child exited before readiness (code 17, signal null)",
    );

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(harness.registry.readStored(harness.identity)).toBeUndefined();
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
  });

  it("has no default readiness deadline while the launched child stays live", async () => {
    const harness = new CoordinatorHarness(roots, { readyDelayMs: 5 });
    let elapsedMs = 0;

    await expect(
      harness
        .coordinator({
          now: () => {
            elapsedMs += 300_001;
            return elapsedMs;
          },
        })
        .ensureRunning(harness.identity),
    ).resolves.toMatchObject({ status: "ready" });

    expect(harness.launcher.launchCount).toBe(1);
    expect(harness.terminator.terminated).toEqual([]);
  });

  it("retries one child exit before readiness without waiting for a deadline", async () => {
    const harness = new CoordinatorHarness(roots, { exitingLaunches: 1 });

    await expect(harness.coordinator().ensureRunning(harness.identity)).resolves.toMatchObject({
      status: "ready",
    });

    expect(harness.launcher.launchCount).toBe(2);
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
  });

  it("surfaces a second child exit instead of retrying indefinitely", async () => {
    const harness = new CoordinatorHarness(roots, { exitingLaunches: 2 });

    await expect(harness.coordinator().ensureRunning(harness.identity)).rejects.toThrow(
      "Daemon child exited before readiness (code 1, signal null)",
    );

    expect(harness.launcher.launchCount).toBe(2);
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
  });

  it("does not reset the retry budget after waiting for startup ownership", async () => {
    const harness = new CoordinatorHarness(roots, { exitingLaunches: 2 });
    const earlierLease = harness.registry.acquireStartup(harness.identity, "earlier-owner");
    setTimeout(() => earlierLease?.release(), 5);

    await expect(harness.coordinator().ensureRunning(harness.identity)).rejects.toThrow(
      "Daemon child exited before readiness (code 1, signal null)",
    );

    expect(harness.launcher.launchCount).toBe(2);
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
  });

  it("recovers a confirmed dead child from legacy caller-owned startup state", async () => {
    const harness = new CoordinatorHarness(roots);
    expect(harness.registry.acquireStartup(harness.identity, "legacy-starting")).toBeDefined();
    harness.registry.write({
      ...harness.readyRecord("legacy-starting", harness.launcher.symnavVersion, 999_999_999),
      state: "starting",
    });

    await expect(
      harness.coordinator({ startupTimeoutMs: 100 }).ensureRunning(harness.identity),
    ).resolves.toMatchObject({ status: "ready", workspaceRoot: "/repo" });

    expect(harness.launcher.launchCount).toBe(1);
    expect(harness.registry.readStored(harness.identity)?.instanceId).not.toBe("legacy-starting");
  });

  it("retains startup ownership when a previous daemon cannot terminate", async () => {
    const harness = new CoordinatorHarness(roots);
    const existing = harness.readyRecord("existing", "0.0.9", 4002);
    harness.seedReady(existing.instanceId, existing.symnavVersion, existing.pid);
    vi.spyOn(harness.transport, "request").mockImplementation(
      async (_endpoint, request): Promise<DaemonResponse> => {
        if (request.kind === "ping") {
          return {
            kind: "pong",
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            instanceId: existing.instanceId,
            symnavVersion: existing.symnavVersion,
          };
        }
        if (request.kind === "identify") {
          return {
            kind: "identity",
            instanceId: existing.instanceId,
            processToken: existing.processToken,
            pid: existing.pid,
            startedAt: existing.startedAt,
          };
        }
        if (request.kind === "terminate") {
          return {
            kind: "terminating",
            instanceId: existing.instanceId,
            processToken: existing.processToken,
          };
        }
        throw new Error(`Unexpected ${request.kind} request`);
      },
    );

    await expect(
      harness.coordinator({ terminationTimeoutMs: 5 }).ensureRunning(harness.identity),
    ).rejects.toBeInstanceOf(DaemonProcessTerminationError);
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
  });

  it("waits beyond startup-owner grace for a live daemon to finish warming", async () => {
    const harness = new CoordinatorHarness(roots);
    let elapsedMs = 0;

    await expect(
      harness
        .coordinator({
          now: () => {
            elapsedMs += 45_000;
            return elapsedMs;
          },
        })
        .ensureRunning(harness.identity),
    ).resolves.toMatchObject({ status: "ready", workspaceRoot: "/repo" });
  });

  it("recovers a durable startup lock when its owner published no record", async () => {
    const harness = new CoordinatorHarness(roots, { neverReady: true });
    expect(harness.registry.acquireStartup(harness.identity, "orphan")).toBeDefined();

    await expect(
      harness
        .coordinator({ processTerminator: new TestProcessTerminator(false) })
        .trigger(harness.identity),
    ).resolves.toMatchObject({ status: "launched" });

    expect(harness.registry.startupOwner(harness.identity)?.instanceId).not.toBe("orphan");
    expect(harness.registry.acquireStartup(harness.identity, "recovered")).toBeUndefined();
  });

  it("does not launch after startup ownership changes before publication", async () => {
    const harness = new CoordinatorHarness(roots);
    vi.spyOn(harness.registry, "writeStartingIfStartupOwner").mockReturnValue(false);

    await expect(harness.coordinator().ensureRunning(harness.identity)).rejects.toThrow(
      "ownership changed before process launch",
    );
    expect(harness.launcher.launchCount).toBe(0);
  });

  it("terminates a child after startup ownership changes during launch", async () => {
    const harness = new CoordinatorHarness(roots);
    const publishStarting = harness.registry.writeStartingIfStartupOwner.bind(harness.registry);
    vi.spyOn(harness.registry, "writeStartingIfStartupOwner")
      .mockImplementationOnce(publishStarting)
      .mockReturnValueOnce(false);

    await expect(harness.coordinator().ensureRunning(harness.identity)).rejects.toThrow(
      "ownership changed after process launch",
    );
    expect(harness.launcher.launchCount).toBe(1);
    expect(harness.terminator.terminated).toContain(harness.launcher.lastPid);
  });

  it("keeps a live daemon-owned startup authoritative through a slow warm", async () => {
    const readinessPublicationGate = new ReadinessPublicationGate();
    const harness = new CoordinatorHarness(roots, { readinessPublicationGate });
    const starting = harness.coordinator().ensureRunning(harness.identity);
    const startingOutcome = starting.then(
      (result) => ({ status: "fulfilled" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    let assertionFailure: unknown;
    try {
      await waitUntil(() => harness.registry.read(harness.identity)?.state === "starting");
      const ownerBeforeStatus = harness.registry.startupOwner(harness.identity);
      const controller = new DaemonController(
        harness.registry,
        harness.transport as unknown as LocalDaemonTransport,
        dirname(harness.identity.registryDirectory),
        { processTerminator: harness.terminator },
      );

      await expect(controller.status()).resolves.toEqual([
        expect.objectContaining({ workspaceRoot: "/repo", state: "starting" }),
      ]);
      await expect(harness.coordinator().trigger(harness.identity)).resolves.toMatchObject({
        status: "starting",
      });
      expect(harness.registry.startupOwner(harness.identity)).toEqual(ownerBeforeStatus);
    } catch (error) {
      assertionFailure = error;
    } finally {
      readinessPublicationGate.release();
    }
    const settledStarting = await startingOutcome;
    if (assertionFailure !== undefined) throw assertionFailure;
    if (settledStarting.status === "rejected") throw settledStarting.error;
    expect(settledStarting.result).toMatchObject({ status: "ready", workspaceRoot: "/repo" });
    expect(harness.launcher.launchCount).toBe(1);
  }, 5_000);

  it("recovers after a slow startup mutation owner is killed and elects one fresh daemon", async () => {
    const harness = new CoordinatorHarness(roots);
    const stateDirectory = dirname(harness.identity.registryDirectory);
    const mutationOwner = await spawnStartupMutationOwner(
      harness.identity.workspaceRoot,
      stateDirectory,
      1_100,
      realProcessIds,
    );
    const mutationOwnerPid = mutationOwner.ownerPid;
    await new NodeDaemonProcessTerminator(100, 5).terminate(mutationOwnerPid);
    mutationOwner.process.kill("SIGKILL");
    expect(harness.registry.list()).toHaveLength(1);
    expect(harness.registry.startupOwner(harness.identity)).toMatchObject({
      instanceId: "orphaned-mutation",
    });
    expect(() => process.kill(mutationOwnerPid, 0)).toThrow();
    const controller = new DaemonController(
      harness.registry,
      harness.transport as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: harness.terminator },
    );

    await expect(controller.status()).resolves.toEqual([]);
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
    expect(
      harness.registry.readStoredInstance(harness.identity, "orphaned-mutation"),
    ).toBeUndefined();
    const [first, second] = await Promise.all([
      harness.coordinator().ensureRunning(harness.identity),
      harness.coordinator().ensureRunning(harness.identity),
    ]);
    expect([first.status, second.status].sort()).toEqual(["already-running", "ready"]);
    expect(harness.launcher.launchCount).toBe(1);
    await expect(harness.coordinator().ensureRunning(harness.identity)).resolves.toMatchObject({
      status: "already-running",
    });
    expect(harness.launcher.launchCount).toBe(1);
  }, 10_000);

  it("observes a real child exit before releasing startup ownership", async () => {
    const root = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", root);
    const registry = new DaemonRegistry(identity.registryDirectory);
    const markerPath = join(root, "late-publication");
    const launcher = new DelayedMarkerLauncher(markerPath, realProcessIds);
    const transport = new RegistryTransport(registry, identity);
    const coordinator = new DaemonStartupCoordinator(
      registry,
      launcher,
      transport as unknown as LocalDaemonTransport,
      { startupTimeoutMs: 1_000, pollIntervalMs: 2 },
    );

    await expect(coordinator.ensureRunning(identity)).rejects.toThrow(/exited before readiness/i);

    expect(existsSync(markerPath)).toBe(true);
    expect(registry.startupOwner(identity)).toBeUndefined();
    expect(registry.readStored(identity)).toBeUndefined();
  });

  it("recovers a durable startup lock when its owner published no record", async () => {
    const harness = new CoordinatorHarness(roots, { neverReady: true });
    expect(harness.registry.acquireStartup(harness.identity, "orphan")).toBeDefined();
    const owner = harness.registry.startupOwner(harness.identity)!;
    writeFileSync(
      harness.identity.startupOwnerPath(harness.identity.lockPath),
      JSON.stringify({ ...owner, heartbeatAt: Date.now() - 20_000 }),
    );

    await expect(
      harness
        .coordinator({ processTerminator: new TestProcessTerminator(false) })
        .trigger(harness.identity),
    ).resolves.toMatchObject({ status: "launched" });

    expect(harness.registry.startupOwner(harness.identity)?.instanceId).not.toBe("orphan");
    expect(harness.registry.acquireStartup(harness.identity, "recovered")).toBeUndefined();
  });

  it("does not launch after startup ownership changes before publication", async () => {
    const harness = new CoordinatorHarness(roots);
    vi.spyOn(harness.registry, "writeStartingIfStartupOwner").mockReturnValue(false);

    await expect(harness.coordinator().ensureRunning(harness.identity)).rejects.toThrow(
      /ownership changed/i,
    );

    expect(harness.launcher.launchCount).toBe(0);
  });

  it("terminates a child after startup ownership changes during launch", async () => {
    const harness = new CoordinatorHarness(roots);
    const publishStarting = harness.registry.writeStartingIfStartupOwner.bind(harness.registry);
    vi.spyOn(harness.registry, "writeStartingIfStartupOwner")
      .mockImplementationOnce(publishStarting)
      .mockReturnValueOnce(false);

    await expect(harness.coordinator().ensureRunning(harness.identity)).rejects.toThrow(
      "ownership changed after process launch",
    );
    expect(harness.launcher.launchCount).toBe(1);
    expect(harness.terminator.terminated).toContain(harness.launcher.lastPid);
  });

  it("does not let the coordinator renew daemon ownership while readiness is pending", async () => {
    const harness = new CoordinatorHarness(roots, { readyDelayMs: 80 });
    const coordinator = harness.coordinator();
    await coordinator.trigger(harness.identity);
    await waitUntil(() => harness.registry.read(harness.identity)?.state === "starting");
    const initialRevision = harness.registry.startupOwner(harness.identity)?.revision;

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.registry.startupOwner(harness.identity)?.revision).toBe(initialRevision);
    await expect(coordinator.waitUntilReady(harness.identity)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("elects one fresh daemon after a mutation owner is killed", async () => {
    const harness = new CoordinatorHarness(roots);
    const stateDirectory = dirname(harness.identity.registryDirectory);
    const mutationOwner = await spawnStartupMutationOwner(
      harness.identity.workspaceRoot,
      stateDirectory,
      10,
      realProcessIds,
    );
    const mutationOwnerPid = mutationOwner.ownerPid;
    await new NodeDaemonProcessTerminator(100, 5).terminate(mutationOwnerPid);
    mutationOwner.process.kill("SIGKILL");
    const controller = new DaemonController(
      harness.registry,
      harness.transport as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: harness.terminator },
    );

    await expect(controller.status()).resolves.toEqual([]);
    const [first, second] = await Promise.all([
      harness.coordinator().ensureRunning(harness.identity),
      harness.coordinator().ensureRunning(harness.identity),
    ]);

    expect([first.status, second.status].sort()).toEqual(["already-running", "ready"]);
    expect(harness.launcher.launchCount).toBe(1);
  }, 10_000);
});

interface CoordinatorHarnessOptions {
  readonly launchFailure?: Error;
  readonly neverReady?: boolean;
  readonly newDaemonPid?: number;
  readonly readyDelayMs?: number;
  readonly readinessPublicationGate?: ReadinessPublicationGate;
  readonly oldDaemonExitsAfterTerminate?: boolean;
  readonly exitingLaunches?: number;
  readonly childExit?: DaemonProcessExit;
  readonly childExitDelayMs?: number;
  readonly readyAuthenticationFailures?: number;
}

class ReadinessPublicationGate {
  private readonly publicationAllowed: Promise<void>;
  private releasePublication!: () => void;

  constructor() {
    this.publicationAllowed = new Promise((resolve) => {
      this.releasePublication = resolve;
    });
  }

  wait(): Promise<void> {
    return this.publicationAllowed;
  }

  release(): void {
    this.releasePublication();
  }
}

class CoordinatorHarness {
  readonly identity: DaemonWorkspaceIdentity;
  readonly registry: DaemonRegistry;
  readonly terminator = new TestProcessTerminator();
  readonly launcher: ReadyTestLauncher;
  readonly transport: RegistryTransport;

  constructor(roots: string[], options: CoordinatorHarnessOptions = {}) {
    const stateDir = temporaryDirectory(roots);
    this.identity = DaemonWorkspaceIdentity.from("/repo", stateDir);
    this.registry = new DaemonRegistry(this.identity.registryDirectory);
    this.launcher = new ReadyTestLauncher(this.registry, this.identity, this.terminator, options);
    this.transport = new RegistryTransport(
      this.registry,
      this.identity,
      (pid) => {
        if (options.oldDaemonExitsAfterTerminate !== false) this.terminator.alive.delete(pid);
      },
      options.readyAuthenticationFailures,
    );
  }

  coordinator(
    options: {
      readonly startupTimeoutMs?: number;
      readonly terminationTimeoutMs?: number;
      readonly processTerminator?: DaemonProcessTerminator;
      readonly now?: () => number;
    } = {},
  ): DaemonStartupCoordinator {
    return new DaemonStartupCoordinator(
      this.registry,
      this.launcher,
      this.transport as unknown as LocalDaemonTransport,
      {
        ...(options.startupTimeoutMs === undefined
          ? {}
          : { startupTimeoutMs: options.startupTimeoutMs }),
        ...(options.terminationTimeoutMs === undefined
          ? {}
          : { terminationTimeoutMs: options.terminationTimeoutMs }),
        pollIntervalMs: 1,
        processTerminator: options.processTerminator ?? this.terminator,
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    );
  }

  seedReady(instanceId: string, symnavVersion: string, pid: number): void {
    this.terminator.alive.add(pid);
    this.registry.write(this.readyRecord(instanceId, symnavVersion, pid));
  }

  readyRecord(instanceId: string, symnavVersion: string, pid: number): DaemonRecord {
    return {
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion,
      workspaceRoot: this.identity.workspaceRoot,
      workspaceKey: this.identity.workspaceKey,
      stateKey: this.identity.stateKey,
      identityKey: this.identity.identityKey,
      instanceId,
      processToken: `${instanceId}-process`,
      endpoint: this.identity.endpoint(instanceId),
      pid,
      state: "ready",
      startedAt: 10,
      readyAt: 20,
      fileCount: 2,
      memoryCapBytes: 256 * 1024 * 1024,
    };
  }
}

class ReadyTestLauncher implements DaemonProcessLauncher {
  readonly symnavVersion = "0.1.0";
  readonly memoryCapBytes = 256 * 1024 * 1024;
  launchCount = 0;
  lastPid = 0;
  private nextPid = 5000;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly identity: DaemonWorkspaceIdentity,
    private readonly terminator: TestProcessTerminator,
    private readonly options: CoordinatorHarnessOptions,
  ) {}

  async launch(_identity: DaemonWorkspaceIdentity, instanceId: string): Promise<DaemonProcess> {
    this.launchCount += 1;
    if (this.options.launchFailure) throw this.options.launchFailure;
    const pid = this.options.newDaemonPid ?? this.nextPid++;
    this.lastPid = pid;
    this.terminator.alive.add(pid);
    const exitsBeforeReadiness = this.launchCount <= (this.options.exitingLaunches ?? 0);
    const childExit = exitsBeforeReadiness
      ? { code: 1, signal: null, cause: "exit" as const }
      : this.options.childExit;
    if (!this.options.neverReady && childExit === undefined) {
      const readinessPublicationGate = this.options.readinessPublicationGate;
      if (readinessPublicationGate === undefined) {
        setTimeout(() => this.publishReady(instanceId), this.options.readyDelayMs ?? 0);
      } else {
        void readinessPublicationGate.wait().then(() => this.publishReady(instanceId));
      }
    }
    const exited: Promise<DaemonProcessExit> =
      childExit === undefined
        ? new Promise(() => undefined)
        : new Promise((resolve) =>
            setTimeout(
              () => {
                this.terminator.alive.delete(pid);
                resolve(childExit);
              },
              exitsBeforeReadiness ? 5 : (this.options.childExitDelayMs ?? 0),
            ),
          );
    return {
      pid,
      exited,
      terminate: () => this.terminator.terminate(pid),
    };
  }

  private publishReady(instanceId: string): void {
    const starting = this.registry.readInstance(this.identity, instanceId);
    if (starting?.state !== "starting") return;
    this.registry.writeIfStartupOwner(this.identity, {
      ...starting,
      state: "ready",
      readyAt: Date.now(),
      fileCount: 2,
    });
  }
}

class RegistryTransport {
  terminationCount = 0;
  private readonly terminatedInstances = new Set<string>();
  private remainingReadyAuthenticationFailures: number;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly identity: DaemonWorkspaceIdentity,
    private readonly daemonTerminated: (pid: number) => void = () => undefined,
    readyAuthenticationFailures = 0,
  ) {
    this.remainingReadyAuthenticationFailures = readyAuthenticationFailures;
  }

  async request(_endpoint: string, request: DaemonRequest): Promise<DaemonResponse> {
    if (request.kind === "stop") {
      return { kind: "stopped", instanceId: request.instanceId };
    }
    if (request.kind === "terminate") {
      this.terminationCount += 1;
      this.terminatedInstances.add(request.instanceId);
      const record = this.registry.readStoredInstance(this.identity, request.instanceId);
      if (record !== undefined) this.daemonTerminated(record.pid);
      return {
        kind: "terminating",
        instanceId: request.instanceId,
        processToken: request.processToken,
      };
    }
    if (request.kind === "identify") {
      if (this.terminatedInstances.has(request.instanceId)) throw new Error("daemon terminated");
      const record = this.registry.readStoredInstance(this.identity, request.instanceId);
      if (record === undefined) throw new Error("missing daemon");
      if (record.state === "ready" && this.remainingReadyAuthenticationFailures > 0) {
        this.remainingReadyAuthenticationFailures -= 1;
        throw new Error("transient authentication failure");
      }
      return {
        kind: "identity",
        instanceId: record.instanceId,
        processToken: record.processToken,
        pid: record.pid,
        startedAt: record.startedAt,
      };
    }
    if (request.kind === "execute") {
      return {
        kind: "result",
        requestId: request.requestId,
        result: { frames: [], exitCode: 0 },
      };
    }
    const record = this.registry.readStoredInstance(this.identity, request.instanceId);
    if (record === undefined) throw new Error("missing daemon");
    return {
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: request.instanceId,
      symnavVersion: record.symnavVersion,
    };
  }

  async execute(
    _endpoint: string,
    request: Extract<DaemonRequest, { kind: "execute" }>,
  ): Promise<DaemonExecutionReceipt> {
    return {
      acceptance: {
        requestId: request.requestId,
        instanceId: request.instanceId,
        acceptedAt: 1,
        queuePosition: 0,
      },
      completion: Promise.resolve({
        status: "completed",
        result: { frames: [], exitCode: 0 },
      }),
    };
  }

  async removeUnavailableEndpoint(_endpoint: string): Promise<boolean> {
    return true;
  }
}

class TestProcessTerminator implements DaemonProcessTerminator {
  readonly alive = new Set<number>();
  readonly terminated: number[] = [];

  constructor(public currentProcessIsAlive = true) {}

  isAlive(pid: number): boolean {
    return (this.currentProcessIsAlive && pid === process.pid) || this.alive.has(pid);
  }

  async terminate(pid: number): Promise<void> {
    this.terminated.push(pid);
    this.alive.delete(pid);
  }
}

class DelayedMarkerLauncher implements DaemonProcessLauncher {
  readonly symnavVersion = "0.1.0";
  readonly memoryCapBytes = 256 * 1024 * 1024;

  constructor(
    private readonly markerPath: string,
    private readonly processIds: number[],
  ) {}

  launch(): Promise<DaemonProcess> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "late"), 200)',
          this.markerPath,
        ],
        { stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("spawn", () => {
        this.processIds.push(child.pid!);
        const terminator = new NodeDaemonProcessTerminator(100, 5);
        const exited = new Promise<DaemonProcessExit>((exitResolve) => {
          child.once("exit", (code, signal) => exitResolve({ code, signal, cause: "exit" }));
        });
        resolve({
          pid: child.pid!,
          exited,
          terminate: () => terminator.terminate(child.pid!),
        });
      });
    });
  }
}

function temporaryDirectory(roots: string[]): string {
  const root = canonicalStateDir(mkdtempSync(join(tmpdir(), "symnav-startup-")));
  roots.push(root);
  return root;
}
function spawnIdleProcess(processIds: number[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      processIds.push(child.pid!);
      resolve(child.pid!);
    });
  });
}

interface StartupMutationOwner {
  readonly process: ChildProcess;
  readonly ownerPid: number;
}

function spawnStartupMutationOwner(
  workspaceRoot: string,
  stateDirectory: string,
  startupDelayMs: number,
  processIds: number[],
): Promise<StartupMutationOwner> {
  const mutationOwner = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
      fileURLToPath(
        new URL("../../test/helpers/daemon-startup-mutation-owner.ts", import.meta.url),
      ),
      workspaceRoot,
      stateDirectory,
      String(startupDelayMs),
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  return new Promise((resolve, reject) => {
    mutationOwner.once("error", reject);
    mutationOwner.once("spawn", () => processIds.push(mutationOwner.pid!));
    mutationOwner.once("exit", (code, signal) => {
      reject(new Error(`Mutation owner exited before readiness: code=${code} signal=${signal}`));
    });
    mutationOwner.once("message", (message) => {
      if (typeof message !== "number" || !Number.isSafeInteger(message) || message <= 0) {
        reject(new Error(`Mutation owner published invalid pid: ${String(message)}`));
        return;
      }
      if (!processIds.includes(message)) processIds.push(message);
      resolve({ process: mutationOwner, ownerPid: message });
    });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for daemon process exit");
}

interface SocketBackedCoordinator {
  readonly identity: DaemonWorkspaceIdentity;
  readonly registry: DaemonRegistry;
  readonly terminator: NodeDaemonProcessTerminator;
  readonly launcher: InProcessReadyLauncher;
  readonly coordinator: DaemonStartupCoordinator;
}

function socketBackedCoordinator(roots: string[]): SocketBackedCoordinator {
  const stateDirectory = temporaryDirectory(roots);
  const identity = DaemonWorkspaceIdentity.from(join(stateDirectory, "workspace"), stateDirectory);
  const registry = new DaemonRegistry(identity.registryDirectory);
  const transport = new LocalDaemonTransport({ requestTimeoutMs: 1_000 });
  const terminator = new NodeDaemonProcessTerminator(100, 5);
  const launcher = new InProcessReadyLauncher(registry, transport);
  return {
    identity,
    registry,
    terminator,
    launcher,
    coordinator: new DaemonStartupCoordinator(registry, launcher, transport, {
      startupTimeoutMs: 5_000,
      pollIntervalMs: 2,
      processTerminator: terminator,
    }),
  };
}

class InProcessReadyLauncher implements DaemonProcessLauncher {
  readonly symnavVersion = "0.1.0";
  readonly memoryCapBytes = 256 * 1024 * 1024;
  private server: Awaited<ReturnType<LocalDaemonTransport["listen"]>> | undefined;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly transport: LocalDaemonTransport,
  ) {}

  async launch(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    processToken: string,
  ): Promise<DaemonProcess> {
    const startingRecord = this.registry.readInstance(identity, instanceId);
    if (startingRecord?.state !== "starting") throw new Error("missing starting record");
    this.server = await this.transport.listen(
      identity.endpoint(instanceId),
      async (request, send) => {
        if (request.kind === "identify") {
          return {
            kind: "identity",
            instanceId,
            processToken,
            pid: process.pid,
            startedAt: startingRecord.startedAt,
          };
        }
        if (request.kind === "terminate") {
          setTimeout(() => void this.close(), 0);
          return { kind: "terminating", instanceId, processToken };
        }
        if (request.kind === "ping") {
          return {
            kind: "pong",
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            instanceId,
            symnavVersion: this.symnavVersion,
          };
        }
        if (request.kind === "execute") {
          send({
            kind: "accepted",
            instanceId,
            processToken,
            requestId: request.requestId,
            acceptedAt: 1,
            queuePosition: 0,
          });
          send({
            kind: "completed",
            instanceId,
            processToken,
            requestId: request.requestId,
            result: { frames: [], exitCode: 0 },
          });
          return;
        }
        return { kind: "stopped", instanceId };
      },
    );
    setTimeout(() => {
      const record = this.registry.readInstance(identity, instanceId);
      if (record?.state !== "starting") return;
      this.registry.writeIfStartupOwner(identity, {
        ...record,
        state: "ready",
        readyAt: Date.now(),
        fileCount: 2,
      });
    }, 0);
    return {
      pid: process.pid,
      exited: new Promise(() => undefined),
      terminate: () => this.close(),
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.close();
  }
}

function readyRecord(
  identity: DaemonWorkspaceIdentity,
  instanceId: string,
  processToken: string,
  pid: number,
): DaemonRecord {
  return {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    workspaceRoot: identity.workspaceRoot,
    workspaceKey: identity.workspaceKey,
    stateKey: identity.stateKey,
    identityKey: identity.identityKey,
    instanceId,
    processToken,
    endpoint: identity.endpoint(instanceId),
    pid,
    state: "ready",
    startedAt: 10,
    readyAt: 20,
    fileCount: 2,
    memoryCapBytes: 256 * 1024 * 1024,
  };
}

function spawnIdentifiableDaemon(
  identity: DaemonWorkspaceIdentity,
  instanceId: string,
  processToken: string,
  startedAt: number,
  processIds: number[],
): Promise<number> {
  if (process.platform !== "win32") {
    mkdirSync(dirname(identity.endpoint(instanceId)), { recursive: true, mode: 0o700 });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        identifiableDaemonSource,
        identity.endpoint(instanceId),
        instanceId,
        processToken,
        String(startedAt),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    child.once("error", reject);
    child.stdout?.once("data", () => {
      processIds.push(child.pid!);
      resolve(child.pid!);
    });
  });
}

const identifiableDaemonSource = `
const { createServer } = require("node:net");
const [endpoint, instanceId, processToken, startedAtText] = process.argv.slice(1);
const startedAt = Number(startedAtText);
const frame = (value) => {
  const payload = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
};
const server = createServer((socket) => {
  let bytes = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length < 4) return;
    const length = bytes.readUInt32BE(0);
    if (bytes.length < length + 4) return;
    const request = JSON.parse(bytes.subarray(4, length + 4).toString("utf8"));
    if (request.kind === "identify") {
      socket.end(frame({ kind: "identity", instanceId, processToken, pid: process.pid, startedAt }));
      return;
    }
    if (request.kind === "ping") {
      socket.end(frame({ kind: "pong", protocolVersion: ${String(
        DAEMON_PROTOCOL_VERSION,
      )}, instanceId, symnavVersion: "0.1.0", startedAt }));
      return;
    }
    if (request.kind === "terminate") {
      socket.end(frame({ kind: "terminating", instanceId, processToken }), () => server.close(() => process.exit(0)));
    }
  });
});
server.listen(endpoint, () => process.stdout.write("ready"));
`;
