import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
