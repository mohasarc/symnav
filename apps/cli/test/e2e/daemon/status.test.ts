import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";
import type { DaemonRecord } from "../../../src/daemon/daemon-protocol.js";

describe("symnav daemon status", () => {
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
    expect(json).toEqual({ stdout: "[]\n", stderr: "", status: 0 });
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
    expect(JSON.parse(json.stdout)).toEqual([
      expect.objectContaining({ state: "ready", pid: expect.any(Number) }),
    ]);
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
      JSON.parse(status.stdout).map((entry: { workspaceRoot: string }) => entry.workspaceRoot),
    ).toEqual(
      [realpathSync(alpha), realpathSync(beta)].sort((left, right) => left.localeCompare(right)),
    );
  });
});

function temporaryStateDirectory(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-daemon-status-e2e-"));
  directories.push(directory);
  return directory;
}

function temporaryWorkspace(directories: string[], label = "workspace"): string {
  const directory = mkdtempSync(join(tmpdir(), `symnav-daemon-status-${label}-`));
  directories.push(directory);
  mkdirSync(join(directory, ".git"));
  writeFileSync(join(directory, "input.ts"), "export const value = 1;\n");
  return directory;
}

function captureDaemonPids(stateDir: string, pids: number[]): void {
  pids.push(...daemonRecords(stateDir).map((record) => record.pid));
}

function daemonRecords(stateDir: string): readonly DaemonRecord[] {
  const recordsDirectory = join(stateDir, "daemons");
  try {
    return readdirSync(recordsDirectory)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) => JSON.parse(readFileSync(join(recordsDirectory, name), "utf8")) as DaemonRecord,
      );
  } catch {
    return [];
  }
}
