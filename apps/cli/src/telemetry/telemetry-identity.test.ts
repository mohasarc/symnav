import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NodeTelemetryIdentityProvider,
  type GitRemoteReader,
} from "./telemetry-identity.js";

class FakeGitRemoteReader implements GitRemoteReader {
  public constructor(private readonly remote: string | undefined) {}

  public read(_workspaceRoot: string): string | undefined {
    return this.remote;
  }
}

describe("NodeTelemetryIdentityProvider", () => {
  it("creates and reuses a persisted machine id", () => {
    const stateDir = createStateDir();
    const provider = new NodeTelemetryIdentityProvider(
      stateDir,
      new FakeGitRemoteReader("git@github.com:o/r.git"),
    );

    const firstIdentity = provider.resolve({
      cwd: "/work/repo",
      workspaceRoot: "/work/repo",
    });
    const persistedMachineId = readFileSync(join(stateDir, "machine-id"), "utf8");
    const secondIdentity = provider.resolve({
      cwd: "/work/repo",
      workspaceRoot: "/work/repo",
    });

    expect(firstIdentity.machineId).toMatch(uuidPattern);
    expect(persistedMachineId).toBe(firstIdentity.machineId);
    expect(secondIdentity.machineId).toBe(firstIdentity.machineId);
  });

  it("hashes the git remote for workspace id", () => {
    const firstProvider = new NodeTelemetryIdentityProvider(
      createStateDir(),
      new FakeGitRemoteReader("git@github.com:o/r.git"),
    );
    const secondProvider = new NodeTelemetryIdentityProvider(
      createStateDir(),
      new FakeGitRemoteReader("git@github.com:o/r.git"),
    );

    const firstIdentity = firstProvider.resolve({
      cwd: "/work/one",
      workspaceRoot: "/work/one",
    });
    const secondIdentity = secondProvider.resolve({
      cwd: "/work/two",
      workspaceRoot: "/work/two",
    });

    expect(firstIdentity.workspaceId).toBe(stableHash("git@github.com:o/r.git"));
    expect(secondIdentity.workspaceId).toBe(firstIdentity.workspaceId);
  });

  it("falls back to the workspace root when no git remote exists", () => {
    const provider = new NodeTelemetryIdentityProvider(
      createStateDir(),
      new FakeGitRemoteReader(undefined),
    );

    const identity = provider.resolve({
      cwd: "/work/repo/src",
      workspaceRoot: "/work/repo",
    });

    expect(identity.workspaceId).toBe(stableHash("/work/repo"));
  });

  it("falls back to cwd when the workspace root is unavailable", () => {
    const provider = new NodeTelemetryIdentityProvider(
      createStateDir(),
      new FakeGitRemoteReader("git@github.com:o/r.git"),
    );

    const identity = provider.resolve({
      cwd: "/work/repo/src",
      workspaceRoot: undefined,
    });

    expect(identity.workspaceId).toBe(stableHash("/work/repo/src"));
  });

  it("keeps machine id independent from workspace id", () => {
    const firstProvider = new NodeTelemetryIdentityProvider(
      createStateDir(),
      new FakeGitRemoteReader("git@github.com:o/r.git"),
    );
    const secondProvider = new NodeTelemetryIdentityProvider(
      createStateDir(),
      new FakeGitRemoteReader("git@github.com:o/r.git"),
    );

    const firstIdentity = firstProvider.resolve({
      cwd: "/work/repo",
      workspaceRoot: "/work/repo",
    });
    const secondIdentity = secondProvider.resolve({
      cwd: "/work/repo",
      workspaceRoot: "/work/repo",
    });

    expect(firstIdentity.workspaceId).toBe(secondIdentity.workspaceId);
    expect(firstIdentity.machineId).not.toBe(secondIdentity.machineId);
  });
});

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function createStateDir(): string {
  const stateDir = mkdtempSync(join(tmpdir(), "symnav-telemetry-identity-"));
  expect(existsSync(join(stateDir, "machine-id"))).toBe(false);
  return stateDir;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
