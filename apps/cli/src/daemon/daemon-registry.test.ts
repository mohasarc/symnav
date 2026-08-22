import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

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
});

function temporaryDirectory(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "symnav-daemon-registry-"));
  roots.push(root);
  return root;
}
