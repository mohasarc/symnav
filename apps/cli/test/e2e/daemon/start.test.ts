import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

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
    const cwd = fixturePath("trivial-project");
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
});

function temporaryStateDirectory(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-daemon-e2e-"));
  directories.push(directory);
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
