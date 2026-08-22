import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonRecord } from "./daemon-protocol.js";

interface StartupMutationLeaseTestAccess {
  beginStartupMutation(identity: DaemonWorkspaceIdentity):
    | { isOwned(): boolean; release(): void }
    | undefined;
  startupMutationOwnerIsLive(identity: DaemonWorkspaceIdentity): boolean;
}

describe("daemon registry", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("keys repositories, worktrees, and submodules by exact workspace root", () => {
    const stateDir = temporaryDirectory(roots);
    const identities = ["/repo", "/repo-worktree", "/repo/submodule"].map((root) =>
      DaemonWorkspaceIdentity.from(root, stateDir),
    );

    expect(new Set(identities.map((identity) => identity.workspaceKey)).size).toBe(3);
    expect(identities.map((identity) => identity.workspaceRoot)).toEqual([
      "/repo",
      "/repo-worktree",
      "/repo/submodule",
    ]);
  });

  it("atomically replaces records without leaving temporary files", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    registry.write(record(identity, "starting"));
    registry.write({ ...record(identity, "ready"), readyAt: 20 });

    expect(registry.read(identity)).toMatchObject({ state: "ready", readyAt: 20 });
    expect(readFileSync(identity.recordPath("instance"), "utf8")).toBe(
      JSON.stringify({ ...record(identity, "ready"), readyAt: 20 }),
    );
    expect(readdirSync(identity.registryDirectory).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });

  it("admits one startup winner and removes a stale lock only for its nonce", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    const lease = registry.acquireStartup(identity, "winner");

    expect(lease).toBeDefined();
    expect(registry.acquireStartup(identity, "loser")).toBeUndefined();
    expect(registry.removeStartupLockIfInstance(identity, "loser")).toBe(false);
    expect(registry.removeStartupLockIfInstance(identity, "winner")).toBe(true);
    expect(registry.acquireStartup(identity, "next")).toBeDefined();
  });

  it("does not remove a replacement record when cleaning up an old instance", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    registry.write(record(identity, "ready", "new"));
    registry.removeIfInstance(identity, "old");
    expect(registry.read(identity)?.instanceId).toBe("new");
    registry.removeIfInstance(identity, "new");
    expect(registry.read(identity)).toBeUndefined();
  });

  it("does not release a replacement startup owner from an old lease", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    const oldLease = registry.acquireStartup(identity, "old");
    expect(oldLease).toBeDefined();
    expect(registry.removeStartupLockIfInstance(identity, "old")).toBe(true);
    const replacementLease = registry.acquireStartup(identity, "replacement");
    expect(replacementLease).toBeDefined();

    oldLease?.release();

    expect(registry.startupOwner(identity)?.instanceId).toBe("replacement");
    replacementLease?.release();
  });

  it("keeps replacement ownership when two processes clean the old owner", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    expect(registry.acquireStartup(identity, "old")).toBeDefined();
    const barrierPath = join(stateDirectory, "cleaners-go");
    const readyPaths = [join(stateDirectory, "cleaner-one"), join(stateDirectory, "cleaner-two")];
    const cleaners = readyPaths.map((readyPath) =>
      spawnRegistryCleaner(identity.workspaceRoot, stateDirectory, "old", readyPath, barrierPath),
    );
    await waitUntil(() => readyPaths.every((path) => existsSync(path)));

    writeFileSync(barrierPath, "go");
    await waitUntil(() => registry.startupOwner(identity) === undefined);
    const replacementLease = registry.acquireStartup(identity, "replacement");
    expect(replacementLease).toBeDefined();
    await Promise.all(cleaners.map(waitForProcess));

    expect(registry.startupOwner(identity)?.instanceId).toBe("replacement");
    replacementLease?.release();
  }, 10_000);

  it("does not publish late readiness after startup ownership is replaced", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    const oldLease = registry.acquireStartup(identity, "old");
    registry.write(record(identity, "starting", "old"));
    expect(registry.removeStartupLockIfInstance(identity, "old")).toBe(true);
    const replacementLease = registry.acquireStartup(identity, "replacement");
    registry.write(record(identity, "starting", "replacement"));

    expect(
      registry.writeIfStartupOwner(identity, {
        ...record(identity, "ready", "old"),
        readyAt: 20,
        fileCount: 2,
      }),
    ).toBe(false);
    expect(
      registry.writeIfStartupOwner(identity, {
        ...record(identity, "ready", "replacement"),
        readyAt: 20,
        fileCount: 2,
      }),
    ).toBe(true);
    expect(registry.read(identity)?.instanceId).toBe("replacement");

    oldLease?.release();
    replacementLease?.release();
  });

  it("publishes starting records only for the current startup owner", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    const lease = registry.acquireStartup(identity, "starting");
    const starting = { ...record(identity, "starting", "starting"), pid: 0 };

    expect(registry.writeStartingIfStartupOwner(identity, starting)).toBe(true);
    expect(registry.removeStartupLockIfInstance(identity, "starting")).toBe(true);
    expect(registry.acquireStartup(identity, "replacement")).toBeDefined();
    expect(registry.writeStartingIfStartupOwner(identity, { ...starting, pid: 777 })).toBe(false);
    expect(registry.readStoredInstance(identity, "starting")?.pid).toBe(0);

    lease?.release();
  });

  it("renews startup ownership with a new revision", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    expect(registry.acquireStartup(identity, "owner")).toBeDefined();
    const before = registry.startupOwner(identity)!;

    expect(registry.refreshStartupOwner(identity, "owner")).toBe(true);

    expect(registry.startupOwner(identity)).toMatchObject({
      instanceId: "owner",
      acquiredAt: before.acquiredAt,
    });
    expect(registry.startupOwner(identity)?.revision).not.toBe(before.revision);
    expect(registry.startupOwner(identity)!.heartbeatAt).toBeGreaterThanOrEqual(before.heartbeatAt);
  });

  it("does not remove startup ownership renewed after stale observation", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    expect(registry.acquireStartup(identity, "owner")).toBeDefined();
    const observedOwner = registry.startupOwner(identity)!;
    expect(registry.refreshStartupOwner(identity, "owner")).toBe(true);

    expect(registry.removeStartupLockIfOwner(identity, observedOwner)).toBe(false);
    expect(registry.startupOwner(identity)?.instanceId).toBe("owner");
  });

  it("measures startup ownership grace from the latest heartbeat", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    expect(registry.acquireStartup(identity, "owner")).toBeDefined();
    const owner = registry.startupOwner(identity)!;

    expect(registry.startupOwnerIsWithinGrace(owner, 100, owner.heartbeatAt + 100)).toBe(true);
    expect(registry.startupOwnerIsWithinGrace(owner, 100, owner.heartbeatAt + 101)).toBe(false);
  });

  it("admits one startup mutation lease at a time", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    const mutations = registry as unknown as StartupMutationLeaseTestAccess;

    const first = mutations.beginStartupMutation(identity);
    expect(first).toBeDefined();
    expect(mutations.beginStartupMutation(identity)).toBeUndefined();
  });

  it("releases startup mutation ownership for the next lease", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    const mutations = registry as unknown as StartupMutationLeaseTestAccess;
    const first = mutations.beginStartupMutation(identity)!;

    expect(first.isOwned()).toBe(true);
    first.release();

    expect(mutations.beginStartupMutation(identity)).toBeDefined();
  });

  it("recognizes a live startup mutation owner", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    const mutations = registry as unknown as StartupMutationLeaseTestAccess;
    const mutation = mutations.beginStartupMutation(identity)!;

    expect(mutations.startupMutationOwnerIsLive(identity)).toBe(true);
    mutation.release();
    expect(mutations.startupMutationOwnerIsLive(identity)).toBe(false);
  });

  it("recovers a startup mutation abandoned by a dead process", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    mkdirSync(identity.startupMutationPath, { recursive: true });
    writeFileSync(
      identity.startupOwnerPath(identity.startupMutationPath),
      JSON.stringify({ ownerPid: 999_999_999, acquiredAt: 0, token: "abandoned" }),
    );

    const mutation = (registry as unknown as StartupMutationLeaseTestAccess).beginStartupMutation(
      identity,
    );

    expect(mutation?.isOwned()).toBe(true);
    mutation?.release();
  });

  it("does not renew startup ownership while another mutation owns the boundary", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    expect(registry.acquireStartup(identity, "owner")).toBeDefined();
    const observedOwner = registry.startupOwner(identity);
    const mutation = (registry as unknown as StartupMutationLeaseTestAccess).beginStartupMutation(
      identity,
    );

    expect(registry.refreshStartupOwner(identity, "owner")).toBe(false);
    expect(registry.startupOwner(identity)).toEqual(observedOwner);
    mutation?.release();
  });

  it("does not remove startup ownership while another mutation owns the boundary", () => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    expect(registry.acquireStartup(identity, "owner")).toBeDefined();
    const observedOwner = registry.startupOwner(identity)!;
    const mutation = (registry as unknown as StartupMutationLeaseTestAccess).beginStartupMutation(
      identity,
    );

    expect(registry.removeStartupLockIfOwner(identity, observedOwner)).toBe(false);
    expect(registry.startupOwner(identity)).toEqual(observedOwner);
    mutation?.release();
  });

  it.each([
    { field: "schemaVersion", value: 2 },
    { field: "protocolVersion", value: DAEMON_PROTOCOL_VERSION + 1 },
    { field: "workspaceRoot", value: "/other" },
    { field: "workspaceKey", value: "other-key" },
    { field: "endpoint", value: "other-endpoint" },
  ] as const)("rejects records with incompatible $field", ({ field, value }) => {
    const identity = DaemonWorkspaceIdentity.from("/repo", temporaryDirectory(roots));
    const registry = new DaemonRegistry(identity.registryDirectory);
    const incompatible = {
      ...record(identity, "ready", "incompatible"),
      readyAt: 20,
      fileCount: 2,
      [field]: value,
    } satisfies DaemonRecord;
    registry.write(incompatible);

    expect(registry.read(identity)).toBeUndefined();
    expect(registry.readInstance(identity, "incompatible")).toBeUndefined();
    expect(registry.list()).toEqual([]);
    if (field === "workspaceRoot" || field === "workspaceKey" || field === "endpoint") {
      expect(registry.readStored(identity)).toBeUndefined();
    } else {
      expect(registry.readStored(identity)?.instanceId).toBe("incompatible");
    }
  });
  it("reports validated ready and live starting daemons sorted by workspace", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const registryDirectory = join(stateDirectory, "daemons");
    const registry = new DaemonRegistry(registryDirectory);
    const beta = DaemonWorkspaceIdentity.from("/beta", stateDirectory);
    const alpha = DaemonWorkspaceIdentity.from("/alpha", stateDirectory);
    registry.write({ ...record(beta, "ready", "beta"), pid: 301, lastNavigationAt: 80 });
    registry.write({ ...record(alpha, "starting", "alpha"), pid: 302 });
    const alphaLease = registry.acquireStartup(alpha, "alpha");
    const transport = new ControllerTransport(registry);
    transport.live.add("beta");
    const terminator = new ControllerTerminator([process.pid]);
    const controller = new DaemonController(
      registry,
      transport as unknown as LocalDaemonTransport,
      stateDirectory,
      { now: () => 100, processTerminator: terminator },
    );

    await expect(controller.status()).resolves.toEqual([
      {
        workspaceRoot: "/alpha",
        state: "starting",
        pid: 302,
        uptimeMs: 90,
      },
      {
        workspaceRoot: "/beta",
        state: "ready",
        pid: 301,
        uptimeMs: 90,
        fileCount: 2,
        memoryBytes: 1234,
        lastRequestAgoMs: 20,
      },
    ]);
    alphaLease?.release();
  });

  it("cleans stale records and does not trust a live PID without a matching ping", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    registry.write({ ...record(identity, "ready", "stale"), pid: 401 });
    const controller = new DaemonController(
      registry,
      new ControllerTransport(registry) as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: new ControllerTerminator([401]) },
    );

    await expect(controller.status()).resolves.toEqual([]);
    expect(registry.readStoredInstance(identity, "stale")).toBeUndefined();
  });

  it("drains a validated daemon and compare-removes only its record", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    registry.write({ ...record(identity, "ready", "old"), pid: 501 });
    const transport = new ControllerTransport(registry);
    transport.live.add("old");
    transport.onStop = () => {
      transport.live.delete("old");
      terminator.alive.delete(501);
      registry.write({ ...record(identity, "ready", "replacement"), pid: 502 });
    };
    const terminator = new ControllerTerminator([501, 502]);
    const controller = new DaemonController(
      registry,
      transport as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: terminator, stopTimeoutMs: 5, pollIntervalMs: 1 },
    );

    await expect(controller.stop("/repo")).resolves.toEqual({
      status: "stopped",
      workspaceRoot: "/repo",
      pid: 501,
    });
    expect(registry.readStoredInstance(identity, "replacement")).toBeDefined();
    expect(terminator.terminated).toEqual([]);
  });

  it("force-terminates a validated daemon after the drain deadline", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    registry.write({ ...record(identity, "ready", "stuck"), pid: 601 });
    const transport = new ControllerTransport(registry);
    transport.live.add("stuck");
    const terminator = new ControllerTerminator([601]);
    transport.onKill = () => {
      transport.live.delete("stuck");
      terminator.alive.delete(601);
    };
    const controller = new DaemonController(
      registry,
      transport as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: terminator, stopTimeoutMs: 20, pollIntervalMs: 1 },
    );

    await expect(controller.stop("/repo")).resolves.toEqual({
      status: "killed",
      workspaceRoot: "/repo",
      pid: 601,
    });
    expect(transport.killed).toEqual(["stuck"]);
    expect(terminator.terminated).toEqual([]);
  });

  it("does not signal a reused PID when identity changes at the kill boundary", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    registry.write({ ...record(identity, "ready", "old"), pid: 602 });
    const transport = new ControllerTransport(registry);
    transport.live.add("old");
    transport.onKill = () => {
      transport.live.delete("old");
      registry.removeIfInstance(identity, "old");
      registry.write({ ...record(identity, "ready", "replacement"), pid: 602 });
      throw new Error("identity changed");
    };
    const terminator = new ControllerTerminator([602]);
    const controller = new DaemonController(
      registry,
      transport as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: terminator, stopTimeoutMs: 0, pollIntervalMs: 1 },
    );

    await expect(controller.stop("/repo")).rejects.toThrow("authenticated kill");
    expect(registry.readStoredInstance(identity, "replacement")).toBeDefined();
    expect(terminator.terminated).toEqual([]);
  });

  it("treats an absent daemon as a successful stop", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const registry = new DaemonRegistry(join(stateDirectory, "daemons"));
    const controller = new DaemonController(
      registry,
      new ControllerTransport(registry) as unknown as LocalDaemonTransport,
      stateDirectory,
    );

    await expect(controller.stop("/repo")).resolves.toEqual({
      status: "not-running",
      workspaceRoot: "/repo",
    });
  });

  it("cleans a stale registered daemon while stopping", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    registry.write({ ...record(identity, "ready", "stale-stop"), pid: 999_999_999 });
    const controller = new DaemonController(
      registry,
      new ControllerTransport(registry) as unknown as LocalDaemonTransport,
      stateDirectory,
    );

    await expect(controller.stop("/repo")).resolves.toEqual({
      status: "not-running",
      workspaceRoot: "/repo",
    });
    expect(registry.readStoredInstance(identity, "stale-stop")).toBeUndefined();
  });
});

class ControllerTransport {
  readonly live = new Set<string>();
  readonly killed: string[] = [];
  onStop: (() => void) | undefined;
  onKill: (() => void) | undefined;

  constructor(private readonly registry: DaemonRegistry) {}

  async request(_endpoint: string, request: DaemonRequest): Promise<DaemonResponse> {
    const records = this.registry.list();
    const record = records.find((candidate) => candidate.instanceId === request.instanceId);
    if (record === undefined || !this.live.has(request.instanceId)) throw new Error("unreachable");
    if (request.kind === "identify") {
      return {
        kind: "identity",
        instanceId: record.instanceId,
        processToken: record.processToken,
        pid: record.pid,
        startedAt: record.startedAt,
      };
    }
    if (request.kind === "ping") {
      return {
        kind: "pong",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: record.instanceId,
        symnavVersion: record.symnavVersion,
        startedAt: record.startedAt,
        fileCount: record.fileCount ?? 0,
        memoryBytes: 1234,
        ...(record.lastNavigationAt === undefined
          ? {}
          : { lastNavigationAt: record.lastNavigationAt }),
      };
    }
    if (request.kind === "stop") {
      this.onStop?.();
      return { kind: "stopped", instanceId: record.instanceId };
    }
    if (request.kind === "kill") {
      this.onKill?.();
      this.killed.push(record.instanceId);
      return {
        kind: "killing",
        instanceId: record.instanceId,
        processToken: record.processToken,
      };
    }
    throw new Error(`Unsupported controller request ${request.kind}`);
  }

  async removeUnavailableEndpoint(): Promise<boolean> {
    return true;
  }
}

class ControllerTerminator implements DaemonProcessTerminator {
  readonly alive: Set<number>;
  readonly terminated: number[] = [];

  constructor(alive: readonly number[]) {
    this.alive = new Set(alive);
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async terminate(pid: number): Promise<void> {
    this.terminated.push(pid);
    this.alive.delete(pid);
  }
}

function temporaryDirectory(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "symnav-registry-"));
  roots.push(root);
  return root;
}

function spawnRegistryCleaner(
  workspaceRoot: string,
  stateDirectory: string,
  instanceId: string,
  readyPath: string,
  barrierPath: string,
): ChildProcess {
  return spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
      fileURLToPath(new URL("../../test/helpers/daemon-registry-cleaner.ts", import.meta.url)),
      workspaceRoot,
      stateDirectory,
      instanceId,
      readyPath,
      barrierPath,
    ],
    { stdio: "ignore" },
  );
}

function waitForProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Registry cleaner exited with code ${String(code)}`));
    });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for registry race");
}

function record(
  identity: DaemonWorkspaceIdentity,
  state: DaemonRecord["state"],
  instanceId = "instance",
): DaemonRecord {
  const base: DaemonRecord = {
    schemaVersion: 1,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    workspaceRoot: identity.workspaceRoot,
    workspaceKey: identity.workspaceKey,
    instanceId,
    processToken: `${instanceId}-process`,
    endpoint: identity.endpoint(instanceId),
    pid: 123,
    state,
    startedAt: 10,
    memoryCapBytes: 256 * 1024 * 1024,
  };
  return state === "ready" ? { ...base, readyAt: 20, fileCount: 2 } : base;
}
