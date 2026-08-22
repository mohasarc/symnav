import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";

describe("symnav daemon start", () => {
  const stateDirectories: string[] = [];
  const daemonPids: number[] = [];

  afterEach(() => {
    for (const pid of daemonPids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    daemonPids.length = 0;
    for (const directory of stateDirectories) rmSync(directory, { recursive: true, force: true });
    stateDirectories.length = 0;
  });

  it("starts, warms, and then reports the existing daemon", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const first = runSymnavBinary(["daemon", "start"], {
      cwd,
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    captureDaemonPid(stateDir, daemonPids);
    const second = runSymnavBinary(["daemon", "start"], {
      cwd,
      env: { SYMNAV_STATE_DIR: stateDir },
    });

    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toMatch(/^Daemon ready for .+\n\d+ files loaded in .+\n$/);
    expect(second.status).toBe(0);
    expect(second.stderr).toBe("");
    expect(second.stdout).toMatch(/^Daemon already running for .+ \(pid \d+, up .+\)\n$/);
  });

  it("supports --cwd and stable JSON", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const result = runSymnavBinary(["--cwd", cwd, "daemon", "start", "--json"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    captureDaemonPid(stateDir, daemonPids);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ready",
      workspaceRoot: resolve(cwd),
    });
  });

  it("preserves non-git errors and honors SYMNAV_DAEMON=0", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const workspace = temporaryWorkspace(stateDirectories);
    const nonGit = runSymnavBinary(["daemon", "start"], {
      cwd: stateDir,
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    const disabled = runSymnavBinary(["daemon", "start"], {
      cwd: workspace,
      env: { SYMNAV_STATE_DIR: stateDir, SYMNAV_DAEMON: "0" },
    });

    expect(nonGit.status).toBe(1);
    expect(nonGit.stderr).toContain("Cannot answer: not in a git workspace");
    expect(disabled.status).toBe(1);
    expect(disabled.stderr).toBe("Daemon disabled by SYMNAV_DAEMON=0\n");
  });
});

function temporaryStateDirectory(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-daemon-e2e-"));
  directories.push(directory);
  return directory;
}

function temporaryWorkspace(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-daemon-workspace-"));
  directories.push(directory);
  mkdirSync(join(directory, ".git"));
  writeFileSync(join(directory, "input.ts"), "export const value = 1;\n");
  return directory;
}

function captureDaemonPid(stateDir: string, pids: number[]): void {
  const recordsDirectory = join(stateDir, "daemons");
  const recordName = readdirSync(recordsDirectory).find((name) => name.endsWith(".json"));
  const record =
    recordName === undefined
      ? undefined
      : (JSON.parse(readFileSync(join(recordsDirectory, recordName), "utf8")) as { pid: number });
  if (record) pids.push(record.pid);
}
