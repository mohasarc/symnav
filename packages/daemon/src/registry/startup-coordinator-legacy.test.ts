import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    execute: vi.fn(async () => {
      throw new Error("Unexpected execution");
    }),
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
    for (const fixture of fixtures.splice(0))
      rmSync(fixture.root, { recursive: true, force: true });
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
});
