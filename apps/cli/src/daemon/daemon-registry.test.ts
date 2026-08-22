import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonRecord } from "./daemon-protocol.js";

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
});

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
