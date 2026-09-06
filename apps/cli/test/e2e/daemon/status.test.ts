import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";
import { canonicalWorkspaceRoot } from "../../helpers/canonical-workspace-root.js";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";
import { CliDaemonTesting } from "../../helpers/daemon-testing.js";

describe("symnav daemon status", () => {
  const stateDirectories: string[] = [];
  const daemonPids: number[] = [];

  afterEach(async () => {
    await E2eProcessCleanup.terminate(daemonPids, []);
    daemonPids.length = 0;
    E2eProcessCleanup.removeDirectories(stateDirectories);
    stateDirectories.length = 0;
  });

  it("reports no daemons in text and JSON", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const text = runSymnavBinary(["daemon", "status"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    const json = runSymnavBinary(["daemon", "status", "--json"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });

    expect(text).toEqual({ stdout: "No daemons running.\n", stderr: "", status: 0 });
    expect(json).toEqual({
      stdout: '{"schemaVersion":1,"daemons":[]}\n',
      stderr: "",
      status: 0,
    });
  });

  it("lists a validated daemon with stable JSON fields", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const started = runSymnavBinary(["daemon", "start"], {
      cwd,
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    captureDaemonPids(stateDir, daemonPids);
    const text = runSymnavBinary(["daemon", "status"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    const json = runSymnavBinary(["daemon", "status", "--json"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });

    expect(started.status).toBe(0);
    expect(text.status).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toMatch(/pid \d+.*files.*(?:B|KB|MB|GB)/);
    expect(JSON.parse(json.stdout)).toEqual({
      schemaVersion: 1,
      daemons: [expect.objectContaining({ state: "ready", pid: expect.any(Number) })],
    });
  });

  it("lists multiple daemons in workspace order", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const beta = temporaryWorkspace(stateDirectories, "beta");
    const alpha = temporaryWorkspace(stateDirectories, "alpha");
    for (const cwd of [beta, alpha]) {
      expect(
        runSymnavBinary(["daemon", "start"], {
          cwd,
          env: { SYMNAV_STATE_DIR: stateDir },
        }).status,
      ).toBe(0);
    }
    captureDaemonPids(stateDir, daemonPids);

    const status = runSymnavBinary(["daemon", "status", "--json"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });

    expect(
      (JSON.parse(status.stdout).daemons as { workspaceRoot: string }[]).map(
        (entry) => entry.workspaceRoot,
      ),
    ).toEqual(
      [realpathSync(alpha), realpathSync(beta)]
        .map(canonicalWorkspaceRoot)
        .sort((left, right) => left.localeCompare(right)),
    );
  });
});

function temporaryStateDirectory(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-daemon-status-e2e-"));
  directories.push(directory);
  return directory;
}

function temporaryWorkspace(directories: string[], name = "workspace"): string {
  const parent = mkdtempSync(join(tmpdir(), `symnav-daemon-status-${name}-`));
  directories.push(parent);
  const workspace = join(parent, name);
  mkdirSync(join(workspace, ".git"), { recursive: true });
  writeFileSync(join(workspace, "input.ts"), "export const value = 1;\n");
  return workspace;
}

function captureDaemonPids(stateDir: string, pids: number[]): void {
  pids.push(...new CliDaemonTesting(stateDir).processIds());
}
