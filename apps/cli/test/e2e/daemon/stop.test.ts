import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";

describe("symnav daemon stop", () => {
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

  it("stops the selected workspace and succeeds again when absent", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const started = runSymnavBinary(["daemon", "start"], {
      cwd,
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    expect(started.status).toBe(0);
    captureDaemonPids(stateDir, daemonPids);

    const stopped = runSymnavBinary(["daemon", "stop"], {
      cwd,
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    const absent = runSymnavBinary(["daemon", "stop"], {
      cwd,
      env: { SYMNAV_STATE_DIR: stateDir },
    });

    expect(stopped.status).toBe(0);
    expect(stopped.stderr).toBe("");
    expect(stopped.stdout).toMatch(/^Stopped daemon for .+ \(pid \d+\)\n$/);
    const events = daemonLogEvents(stateDir);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "start" }),
        expect.objectContaining({ kind: "ready" }),
        expect.objectContaining({ kind: "request", command: "version", exitCode: 0 }),
        expect.objectContaining({ kind: "freshness" }),
        expect.objectContaining({ kind: "stop", reason: "graceful" }),
      ]),
    );
    expect(absent.status).toBe(0);
    expect(absent.stderr).toBe("");
    expect(absent.stdout).toMatch(/^No daemon running for .+\n$/);
  });

  it("supports global --cwd and JSON output", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const started = runSymnavBinary(["--cwd", cwd, "daemon", "start"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    expect(started.status).toBe(0);
    captureDaemonPids(stateDir, daemonPids);

    const result = runSymnavBinary(["--cwd", cwd, "daemon", "stop", "--json"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({ status: "stopped", pid: expect.any(Number) }),
    );
  });
});

function temporaryStateDirectory(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-daemon-stop-e2e-"));
  directories.push(directory);
  return directory;
}

function temporaryWorkspace(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-daemon-stop-workspace-"));
  directories.push(directory);
  mkdirSync(join(directory, ".git"));
  writeFileSync(join(directory, "input.ts"), "export const value = 1;\n");
  return directory;
}

function captureDaemonPids(stateDir: string, pids: number[]): void {
  const recordsDirectory = join(stateDir, "daemons");
  for (const recordName of readdirSync(recordsDirectory).filter((name) => name.endsWith(".json"))) {
    const record = JSON.parse(readFileSync(join(recordsDirectory, recordName), "utf8")) as {
      pid: number;
    };
    pids.push(record.pid);
  }
}

function daemonLogEvents(stateDir: string): readonly Record<string, unknown>[] {
  const recordsDirectory = join(stateDir, "daemons");
  const logName = readdirSync(recordsDirectory).find((name) => name.endsWith(".log"));
  if (logName === undefined) return [];
  return readFileSync(join(recordsDirectory, logName), "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
