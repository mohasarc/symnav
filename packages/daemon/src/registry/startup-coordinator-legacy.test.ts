import { DaemonPolicy } from "../daemon-policy.js";
import { DaemonFailureJournal } from "../diagnostics/failure-journal.js";
import { NodeDaemonClock } from "../lifecycle/daemon-clock.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PosixDaemonProcessLifetime,
  type PosixDaemonChildLifetime,
} from "../process/posix-process-lifetime.js";
import { CommandOutputSnapshot } from "../../test/helpers/executor-output.js";
import { TestDaemonRegistry } from "../../test/helpers/daemon-registry.js";
import { TestDaemonStartupCoordinator } from "../../test/helpers/daemon-startup-coordinator.js";
import { TestNodeDaemonProcessTerminator } from "../../test/helpers/daemon-process-terminator.js";
import type { DaemonProcessLauncher } from "../process/process-launcher.js";
import type {
  DaemonLifecycleRequestSender,
  DaemonExecutionRequester,
} from "../transport/contracts.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
  type DaemonLifecycleRequest,
  type DaemonLifecycleResponse,
} from "../transport/protocol.js";
import type { StartupOwner } from "./registry.js";
import { DaemonWorkspaceIdentity } from "./workspace-identity.js";

class LegacyStartupFixture {
  public readonly root = mkdtempSync(join(tmpdir(), "symnav-legacy-startup-"));
  public readonly identity = DaemonWorkspaceIdentity.from("/repo", this.root);
  public readonly registry = new TestDaemonRegistry(this.identity.registryDirectory);
  public readonly terminator = new TestNodeDaemonProcessTerminator(100, 1);
  public readonly launcher: DaemonProcessLauncher = {
    symnavVersion: "0.1.0",
    memoryCapBytes: 1024,
    launch: vi.fn(async () => {
      throw new Error("Unexpected launch");
    }),
  };
  public readonly transport: DaemonLifecycleRequestSender & DaemonExecutionRequester = {
    request: vi.fn(
      async (
        _endpoint: string,
        request: DaemonLifecycleRequest,
      ): Promise<DaemonLifecycleResponse> => {
        if (request.kind === "identify" && this.authenticated)
          return {
            kind: "identity",
            instanceId: this.record.instanceId,
            processToken: this.record.processToken,
            pid: this.record.pid,
            startedAt: this.record.startedAt,
          };
        if (request.kind === "ping" && this.record.state === "ready")
          return {
            kind: "pong",
            instanceId: this.record.instanceId,
            symnavVersion: this.record.symnavVersion,
            protocolVersion: DAEMON_PROTOCOL_VERSION,
          };
        throw new Error("Unavailable");
      },
    ),
    execute: vi.fn(async () => ({
      acceptance: {
        requestId: "probe",
        instanceId: this.record.instanceId,
        acceptedAt: 1,
        queuePosition: 0,
      },
      completion: Promise.resolve({
        status: "completed" as const,
        result: { output: new CommandOutputSnapshot([]), exitCode: 0 },
      }),
    })),
  };
  public readonly coordinator = new TestDaemonStartupCoordinator(
    this.registry,
    this.launcher,
    this.transport,
    {
      processTerminator: this.terminator,
      pollIntervalMs: 1,
    },
  );
  public record: DaemonRecord;
  public owner: StartupOwner;
  public readonly lifetimes: PosixDaemonChildLifetime[] = [];
  public authenticated = false;
  public observedSnapshot: readonly string[] = [];

  public constructor(
    ownerKind: StartupOwner["ownerKind"] = "daemon",
    processToken = "legacy-token",
  ) {
    this.record = {
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: this.launcher.symnavVersion,
      workspaceRoot: this.identity.workspaceRoot,
      workspaceKey: this.identity.workspaceKey,
      stateKey: this.identity.stateKey,
      identityKey: this.identity.identityKey,
      instanceId: "legacy",
      processToken: "legacy-token",
      endpoint: this.identity.endpoint("legacy"),
      pid: 999_999_999,
      state: "starting",
      startedAt: 10,
      memoryCapBytes: 1024,
    };
    this.owner = {
      identityKey: this.identity.identityKey,
      instanceId: this.record.instanceId,
      processToken,
      ownerKind,
      ownerPid: ownerKind === "daemon" ? this.record.pid : process.pid,
      heartbeatAt: 10,
      acquiredAt: 10,
      revision: "legacy-revision",
    };
    this.publish();
  }

  public lifetime(observation: "live" | "exited" | "unknown") {
    const lifetime = PosixDaemonProcessLifetime.prepareChild(this.root);
    this.lifetimes.push(lifetime);
    if (observation !== "live") lifetime.closeParentCopy();
    if (observation === "unknown") rmSync(lifetime.identity.path);
    return lifetime.identity;
  }

  public publish(): void {
    mkdirSync(this.identity.lockPath, { recursive: true });
    writeFileSync(
      this.identity.startupOwnerPath(this.identity.lockPath),
      JSON.stringify(this.owner),
    );
    writeFileSync(this.identity.recordPath(this.record.instanceId), JSON.stringify(this.record));
  }

  public snapshot(): readonly string[] {
    return [
      readFileSync(this.identity.startupOwnerPath(this.identity.lockPath), "utf8"),
      readFileSync(this.identity.recordPath(this.record.instanceId), "utf8"),
    ];
  }

  public ready(): void {
    this.authenticated = true;
    this.record = { ...this.record, state: "ready", readyAt: 20, fileCount: 1 };
    this.publish();
  }

  public async observe<T>(
    operation: Promise<T>,
  ): Promise<
    { kind: "resolved"; value: T } | { kind: "rejected"; error: unknown } | { kind: "pending" }
  > {
    const outcome = operation.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error) => ({ kind: "rejected" as const, error }),
    );
    try {
      const result = await Promise.race([
        outcome,
        new Promise<{ kind: "pending" }>((resolve) =>
          setTimeout(() => resolve({ kind: "pending" }), 40),
        ),
      ]);
      this.observedSnapshot = this.snapshot();
      return result;
    } finally {
      this.ready();
      await outcome;
    }
  }
}

describe.skipIf(process.platform === "win32")("unverifiable POSIX legacy startup", () => {
  const fixtures: LegacyStartupFixture[] = [];
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      for (const lifetime of fixture.lifetimes) lifetime.closeParentCopy();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["daemon", "launcher", "empty-launcher"] as const)(
    "retains %s ownership across all startup entrypoints",
    async (kind) => {
      for (const entrypoint of ["ensureRunning", "waitUntilReady", "trigger"] as const) {
        const fixture = new LegacyStartupFixture(
          kind === "daemon" ? "daemon" : "launcher",
          kind === "empty-launcher" ? "" : "legacy-token",
        );
        fixtures.push(fixture);
        const before = fixture.snapshot();
        const cleanup = vi.spyOn(fixture.registry, "removeAbandonedStartupOwner");
        const terminate = vi.spyOn(fixture.terminator, "terminate");
        const outcome = await fixture.observe<unknown>(
          fixture.coordinator[entrypoint](fixture.identity),
        );
        expect(outcome).toMatchObject({
          kind: "rejected",
          error: expect.objectContaining({
            message: expect.stringContaining("ownership was retained"),
          }),
        });
        expect(fixture.launcher.launch).not.toHaveBeenCalled();
        expect(terminate).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        // The observation helper publishes readiness only after capturing the original outcome.
        expect(before[0]).toContain("legacy-revision");
      }
    },
  );
  it.each(["ensureRunning", "waitUntilReady", "trigger"] as const)(
    "retains a missing-lifetime record despite an exited owner's lifetime through %s",
    async (entrypoint) => {
      const fixture = new LegacyStartupFixture();
      fixtures.push(fixture);
      fixture.owner = { ...fixture.owner, ownerLifetime: fixture.lifetime("exited") };
      fixture.publish();
      const before = fixture.snapshot();
      const cleanup = vi.spyOn(fixture.registry, "removeAbandonedStartupOwner");
      const outcome = await fixture.observe<unknown>(
        fixture.coordinator[entrypoint](fixture.identity),
      );
      expect(outcome).toMatchObject({
        kind: "rejected",
        error: expect.objectContaining({
          message: expect.stringContaining("ownership was retained"),
        }),
      });
      expect(fixture.observedSnapshot).toEqual(before);
      expect(cleanup).not.toHaveBeenCalled();
      expect(fixture.launcher.launch).not.toHaveBeenCalled();
    },
  );

  it.each(["absent", "exited"] as const)(
    "keeps authenticated legacy warmup with %s owner lifetime pending while ping is unavailable",
    async (ownerLifetime) => {
      const fixture = new LegacyStartupFixture();
      fixtures.push(fixture);
      fixture.authenticated = true;
      if (ownerLifetime === "exited")
        fixture.owner = { ...fixture.owner, ownerLifetime: fixture.lifetime("exited") };
      fixture.publish();
      const before = fixture.snapshot();
      const cleanup = vi.spyOn(fixture.registry, "removeAbandonedStartupOwner");
      expect(await fixture.observe(fixture.coordinator.waitUntilReady(fixture.identity))).toEqual({
        kind: "pending",
      });
      expect(fixture.observedSnapshot).toEqual(before);
      expect(cleanup).not.toHaveBeenCalled();
      expect(fixture.transport.execute).toHaveBeenCalledTimes(1);
      expect(fixture.launcher.launch).not.toHaveBeenCalled();
    },
  );

  it.each(["instanceId", "processToken", "pid", "startedAt"] as const)(
    "rejects identity with mismatched %s",
    async (field) => {
      const fixture = new LegacyStartupFixture();
      fixtures.push(fixture);
      vi.mocked(fixture.transport.request).mockResolvedValue({
        kind: "identity",
        instanceId: fixture.record.instanceId,
        processToken: fixture.record.processToken,
        pid: fixture.record.pid,
        startedAt: fixture.record.startedAt,
        [field]: typeof fixture.record[field] === "number" ? 12 : "wrong",
      });
      expect(
        await fixture.observe(fixture.coordinator.waitUntilReady(fixture.identity)),
      ).toMatchObject({ kind: "rejected" });
    },
  );

  it.each(["live", "unknown"] as const)(
    "keeps modern %s record and owner evidence waiting beyond coordination grace",
    async (observation) => {
      for (const evidence of ["record", "owner"] as const) {
        const fixture = new LegacyStartupFixture();
        fixtures.push(fixture);
        const lifetime = fixture.lifetime(observation);
        if (evidence === "record")
          fixture.record = { ...fixture.record, processLifetime: lifetime };
        else fixture.owner = { ...fixture.owner, ownerLifetime: lifetime };
        fixture.publish();
        const before = fixture.snapshot();
        const cleanup = vi.spyOn(fixture.registry, "removeAbandonedStartupOwner");
        expect(await fixture.observe(fixture.coordinator.waitUntilReady(fixture.identity))).toEqual(
          { kind: "pending" },
        );
        expect(fixture.observedSnapshot).toEqual(before);
        expect(cleanup).not.toHaveBeenCalled();
        expect(fixture.transport.execute).toHaveBeenCalledTimes(1);
        expect(fixture.launcher.launch).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["processToken", "daemon-pid", "empty-daemon-token"] as const)(
    "leaves unmatched %s ownership outside the guard",
    async (mismatch) => {
      const fixture = new LegacyStartupFixture();
      fixtures.push(fixture);
      fixture.owner = {
        ...fixture.owner,
        ...(mismatch === "daemon-pid"
          ? { ownerPid: process.pid }
          : { processToken: mismatch === "empty-daemon-token" ? "" : "wrong" }),
      };
      fixture.publish();
      expect(await fixture.observe(fixture.coordinator.waitUntilReady(fixture.identity))).toEqual({
        kind: "pending",
      });
      expect(fixture.launcher.launch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "ready",
    "record-lifetime",
    "owner-revision",
    "owner-claim",
    "credentials",
    "owner-lifetime",
    "lifetime-observation",
  ] as const)("revalidates %s after awaited authentication", async (publication) => {
    const fixture = new LegacyStartupFixture();
    fixtures.push(fixture);
    if (publication === "lifetime-observation")
      fixture.owner = { ...fixture.owner, ownerLifetime: fixture.lifetime("exited") };
    fixture.publish();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observed!: () => void;
    const entered = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const original = vi.mocked(fixture.transport.request).getMockImplementation()!;
    let first = true;
    vi.mocked(fixture.transport.request).mockImplementation(async (endpoint, request) => {
      if (request.kind === "identify" && first) {
        first = false;
        observed();
        await gate;
        throw new Error("Unavailable old snapshot");
      }
      return original(endpoint, request);
    });
    const operation = fixture.coordinator.waitUntilReady(fixture.identity);
    try {
      await entered;
      fixture.authenticated = true;
      if (publication === "ready") fixture.ready();
      if (publication === "record-lifetime")
        fixture.record = { ...fixture.record, processLifetime: fixture.lifetime("live") };
      if (publication === "owner-revision")
        fixture.owner = { ...fixture.owner, revision: "renewed" };
      if (publication === "owner-claim")
        fixture.owner = { ...fixture.owner, claimToken: "renewed-claim" };
      if (publication === "credentials") {
        fixture.record = { ...fixture.record, processToken: "successor-token", startedAt: 30 };
        fixture.owner = { ...fixture.owner, processToken: "successor-token" };
      }
      if (publication === "owner-lifetime")
        fixture.owner = { ...fixture.owner, ownerLifetime: fixture.lifetime("live") };
      if (publication === "lifetime-observation") rmSync(fixture.owner.ownerLifetime!.path);
      fixture.publish();
      release();
      const result = await fixture.observe(operation);
      expect(result.kind).toBe(publication === "ready" ? "resolved" : "pending");
      expect(fixture.launcher.launch).not.toHaveBeenCalled();
    } finally {
      release();
      fixture.ready();
      await operation.catch(() => undefined);
    }
  });
  it.each(["trigger", "readiness"] as const)(
    "retains mixed legacy ownership with truthful %s journal evidence",
    async (operation) => {
      const fixture = new LegacyStartupFixture();
      fixtures.push(fixture);
      fixture.owner = { ...fixture.owner, ownerLifetime: fixture.lifetime("exited") };
      fixture.publish();
      const before = fixture.snapshot();
      const cleanup = vi.spyOn(fixture.registry, "removeAbandonedStartupOwner");
      const terminate = vi.spyOn(fixture.terminator, "terminate");
      if (operation === "readiness") {
        fixture.authenticated = true;
        const original = vi.mocked(fixture.transport.request).getMockImplementation()!;
        vi.mocked(fixture.transport.request).mockImplementation(async (endpoint, request) => {
          const response = await original(endpoint, request);
          if (request.kind === "identify") fixture.authenticated = false;
          return response;
        });
      }
      const outcome = await fixture.observe(fixture.coordinator.ensureRunning(fixture.identity));
      expect(outcome).toMatchObject({
        kind: "rejected",
        error: expect.objectContaining({
          message: expect.stringContaining("ownership was retained"),
        }),
      });
      expect(fixture.observedSnapshot).toEqual(before);
      expect(cleanup).not.toHaveBeenCalled();
      expect(terminate).not.toHaveBeenCalled();
      expect(fixture.launcher.launch).not.toHaveBeenCalled();
      expect(fixture.transport.execute).not.toHaveBeenCalled();
      const journal = new DaemonFailureJournal(
        fixture.root,
        DaemonPolicy.currentSystem().values.diagnostics,
        new NodeDaemonClock(),
      );
      expect(await journal.retained()).toEqual([
        expect.objectContaining({
          kind: "startup-failure",
          failure: {
            phase: operation === "trigger" ? "process spawn" : "warm-up",
            reason: operation === "trigger" ? "process-spawn-failed" : "startup-failed",
            timestamp: expect.any(Number),
          },
        }),
      ]);
    },
  );
  it("retains authenticated mixed legacy warmup without recording process death", async () => {
    const fixture = new LegacyStartupFixture();
    fixtures.push(fixture);
    fixture.owner = { ...fixture.owner, ownerLifetime: fixture.lifetime("exited") };
    fixture.authenticated = true;
    fixture.publish();
    const before = fixture.snapshot();
    const cleanup = vi.spyOn(fixture.registry, "removeAbandonedStartupOwner");
    await expect(
      fixture.transport.request(fixture.record.endpoint, {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: fixture.record.instanceId,
      }),
    ).rejects.toThrow("Unavailable");
    await expect(fixture.coordinator.trigger(fixture.identity)).resolves.toMatchObject({
      status: "starting",
      instanceId: fixture.record.instanceId,
    });
    expect(await fixture.observe(fixture.coordinator.waitUntilReady(fixture.identity))).toEqual({
      kind: "pending",
    });
    expect(fixture.observedSnapshot).toEqual(before);
    expect(cleanup).not.toHaveBeenCalled();
    expect(fixture.launcher.launch).not.toHaveBeenCalled();
    expect(fixture.transport.execute).toHaveBeenCalledTimes(1);
    const journal = new DaemonFailureJournal(
      fixture.root,
      DaemonPolicy.currentSystem().values.diagnostics,
      new NodeDaemonClock(),
    );
    expect(await journal.retained()).toEqual([]);
  });
});
