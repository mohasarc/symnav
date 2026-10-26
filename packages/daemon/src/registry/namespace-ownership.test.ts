import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestDaemonRegistry } from "../../test/helpers/daemon-registry.js";
import { PosixDaemonProcessLifetime } from "../process/posix-process-lifetime.js";
import { DaemonWorkspaceIdentity } from "./workspace-identity.js";

interface MutationAccess {
  beginStartupMutation(identity: DaemonWorkspaceIdentity): { release(): void } | undefined;
}

describe.skipIf(process.platform === "win32")("namespace-safe startup ownership", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("publishes a nonempty token claim with live authority", () => {
    const state = mkdtempSync(join(tmpdir(), "symnav-namespace-"));
    roots.push(state);
    const identity = DaemonWorkspaceIdentity.from("/repo", state);
    const registry = new TestDaemonRegistry(identity.registryDirectory);
    const lease = registry.acquireStartup(identity, "first")!;
    expect(lease.owner.ownerLifetime).toBeDefined();
    expect(PosixDaemonProcessLifetime.observe(lease.owner.ownerLifetime!)).toBe("live");
    expect(readdirSync(identity.lockPath)).toEqual([lease.owner.claimToken]);
    expect(registry.acquireStartup(identity, "second")).toBeUndefined();
  });

  it("retains a paused foreign mutation owner beyond coordination grace", () => {
    const state = mkdtempSync(join(tmpdir(), "symnav-namespace-"));
    roots.push(state);
    const identity = DaemonWorkspaceIdentity.from("/repo", state);
    const registry = new TestDaemonRegistry(identity.registryDirectory);
    const access = registry as unknown as MutationAccess;
    const held = access.beginStartupMutation(identity)!;
    const token = readdirSync(identity.startupMutationPath)[0]!;
    const path = join(identity.startupMutationPath, token, "owner.json");
    const owner = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...owner, ownerPid: 2147483647, acquiredAt: 0 }));
    expect(access.beginStartupMutation(identity)).toBeUndefined();
    writeFileSync(path, JSON.stringify(owner));
    held.release();
    expect(access.beginStartupMutation(identity)).toBeDefined();
  });

  it("recovers only the dead observed token and keeps a successor", () => {
    const state = mkdtempSync(join(tmpdir(), "symnav-namespace-"));
    roots.push(state);
    const identity = DaemonWorkspaceIdentity.from("/repo", state);
    const registry = new TestDaemonRegistry(identity.registryDirectory);
    const lifetime = PosixDaemonProcessLifetime.prepareChild(state);
    lifetime.closeParentCopy();
    const lease = registry.acquireStartup(identity, {
      identityKey: identity.identityKey,
      instanceId: "dead",
      processToken: "dead-token",
      ownerPid: process.pid,
      ownerKind: "launcher",
      heartbeatAt: 0,
      ownerLifetime: lifetime.identity,
    })!;
    expect(registry.removeAbandonedStartupOwner(identity, lease.owner)).toBe(true);
    const successor = registry.acquireStartup(identity, "fresh")!;
    expect(registry.removeAbandonedStartupOwner(identity, lease.owner)).toBe(false);
    expect(registry.startupOwner(identity)).toEqual(successor.owner);
  });
});
