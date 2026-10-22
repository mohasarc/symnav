import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalTestPath } from "../../test/helpers/canonical-path.js";
import { DaemonWorkspaceIdentity } from "./workspace-identity.js";

describe("DaemonWorkspaceIdentity", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("combines workspace and canonical state location without collisions", () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-identity-"));
    roots.push(root);
    const firstState = join(root, "first-state");
    const secondState = join(root, "second-state");
    mkdirSync(firstState);
    mkdirSync(secondState);

    const first = DaemonWorkspaceIdentity.from("/workspace", CanonicalTestPath.resolve(firstState));
    const second = DaemonWorkspaceIdentity.from(
      "/workspace",
      CanonicalTestPath.resolve(secondState),
    );
    const otherWorkspace = DaemonWorkspaceIdentity.from(
      "/other-workspace",
      CanonicalTestPath.resolve(firstState),
    );

    expect(first.workspaceKey).toBe(second.workspaceKey);
    expect(first.stateKey).not.toBe(second.stateKey);
    expect(first.identityKey).not.toBe(second.identityKey);
    expect(first.stateKey).toBe(otherWorkspace.stateKey);
    expect(first.identityKey).not.toBe(otherWorkspace.identityKey);
    expect(new Set([first.endpoint("instance"), second.endpoint("instance")]).size).toBe(2);
  });

  it("converges equivalent canonical state spellings", () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-identity-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const stateSymlink = join(root, "state-link");
    mkdirSync(stateDirectory);
    symlinkSync(stateDirectory, stateSymlink, process.platform === "win32" ? "junction" : "dir");

    const identities = [
      stateDirectory,
      join(root, ".", "state"),
      stateSymlink,
      CanonicalTestPath.resolve(stateDirectory),
    ].map((stateLocation) =>
      DaemonWorkspaceIdentity.from("/workspace", CanonicalTestPath.resolve(stateLocation)),
    );

    expect(new Set(identities.map((identity) => identity.stateDirectory)).size).toBe(1);
    expect(new Set(identities.map((identity) => identity.stateKey)).size).toBe(1);
    expect(new Set(identities.map((identity) => identity.identityKey)).size).toBe(1);
  });

  it("places lifecycle files under one identity directory and keys endpoints by instance", () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-daemon-identity-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from("/workspace", CanonicalTestPath.resolve(root));
    const lifecyclePaths = [
      identity.recordPath("instance"),
      identity.lockPath,
      identity.startupMutationPath,
      identity.logPath,
      identity.spoolDirectory,
    ];

    expect(lifecyclePaths.every((path) => dirname(path) === identity.identityDirectory)).toBe(true);
    expect(identity.endpoint("first")).not.toBe(identity.endpoint("second"));
    expect(relative(identity.stateDirectory, identity.identityDirectory).startsWith("..")).toBe(
      false,
    );
  });
});
