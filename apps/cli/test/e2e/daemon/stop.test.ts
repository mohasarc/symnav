import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";
import { canonicalWorkspaceRoot } from "../../helpers/canonical-workspace-root.js";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";
import { DaemonFailureContext } from "../../helpers/daemon-failure-context.js";
import { CliDaemonTesting } from "../../helpers/daemon-testing.js";
import { ControlledLifecycleDaemon } from "../../helpers/controlled-lifecycle-daemon.js";

describe("symnav daemon stop", () => {
  const stateDirectories: string[] = [];
  const daemonPids: number[] = [];
  const helperProcesses: ChildProcess[] = [];
  const controlledDaemons: ControlledLifecycleDaemon[] = [];

  afterEach(async () => {
    await Promise.all(controlledDaemons.splice(0).map((daemon) => daemon.dispose()));
    await E2eProcessCleanup.terminate(daemonPids, helperProcesses);
    daemonPids.length = 0;
    helperProcesses.length = 0;
    E2eProcessCleanup.removeDirectories(stateDirectories);
    stateDirectories.length = 0;
  });

  it("returns not-running JSON with global --cwd and leaves another state location untouched", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const otherState = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    expect(
      runSymnavBinary(["--cwd", cwd, "daemon", "start"], {
        cwd: tmpdir(),
        env: { SYMNAV_STATE_DIR: otherState },
      }).status,
    ).toBe(0);
    captureDaemonPids(otherState, daemonPids);
    const absent = runSymnavBinary(["--cwd", cwd, "daemon", "stop", "--json"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    expect(absent).toEqual({
      stdout: `${JSON.stringify({ status: "not-running", workspaceRoot: canonicalWorkspaceRoot(cwd) })}\n`,
      stderr: "",
      status: 0,
    });
    expect(new CliDaemonTesting(otherState).processIds()).toHaveLength(1);
  });

  it("stops controlled startup without leaving a process", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const daemon = await ControlledLifecycleDaemon.start(cwd, stateDir, "starting");
    controlledDaemons.push(daemon);
    const result = await daemon.runAsync(["daemon", "stop"]);
    await new DaemonFailureContext({
      stateDirectory: stateDir,
      workspaceRoot: cwd,
      result,
      actor: daemon,
    }).assert(async () => {
      expect(result).toEqual({
        stdout: `Stopped daemon for ${daemon.workspaceRoot} (pid ${String(daemon.actor.pid)})\n`,
        stderr: "",
        status: 0,
      });
      await E2eProcessCleanup.waitForExit([daemon.actor.pid!]);
      expect(new CliDaemonTesting(stateDir).inspector.listInstances()).toEqual([]);
    });
  });

  it("lets accepted long-running work finish before a graceful stop", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const daemon = await ControlledLifecycleDaemon.start(cwd, stateDir);
    controlledDaemons.push(daemon);
    const navigation = daemon.runAsync(["overview", "input.ts"]);
    await daemon.waitForRequest();
    const stopped = daemon.runAsync(["daemon", "stop", "--json"]);
    await daemon.waitForStatus(
      (report) =>
        report.daemons[0]?.state === "recovering" && report.daemons[0].detail === "draining",
    );
    daemon.release();
    const navigationResult = await navigation;
    await new DaemonFailureContext({
      stateDirectory: stateDir,
      workspaceRoot: cwd,
      result: navigationResult,
      actor: daemon,
    }).assert(() => {
      expect(navigationResult).toMatchObject({ status: 0, stderr: "" });
    });
    const result = await stopped;
    await new DaemonFailureContext({
      stateDirectory: stateDir,
      workspaceRoot: cwd,
      result,
      actor: daemon,
    }).assert(async () => {
      expect(result).toEqual({
        status: 0,
        stderr: "",
        stdout: `${JSON.stringify({ status: "stopped", workspaceRoot: daemon.workspaceRoot, pid: daemon.actor.pid })}\n`,
      });
      expect(await daemon.exited).toBe(0);
      await E2eProcessCleanup.waitForExit([daemon.actor.pid!]);
    });
  }, 15_000);

  it.each([false, true])(
    "kills accepted stuck work within the five-second stop policy with json=%s",
    async (json) => {
      const stateDir = temporaryStateDirectory(stateDirectories);
      const cwd = temporaryWorkspace(stateDirectories);
      const daemon = await ControlledLifecycleDaemon.start(cwd, stateDir, "stuck");
      controlledDaemons.push(daemon);
      const navigation = daemon.runAsync(["overview", "input.ts"]);
      await daemon.waitForRequest();
      const startedAt = Date.now();
      const result = await daemon.runAsync(["daemon", "stop", ...(json ? ["--json"] : [])]);
      const elapsedMs = Date.now() - startedAt;
      await new DaemonFailureContext({
        stateDirectory: stateDir,
        workspaceRoot: cwd,
        result,
        elapsedMs,
        actor: daemon,
      }).assert(async () => {
        expect(result).toEqual({
          status: 0,
          stderr: "",
          stdout: json
            ? `${JSON.stringify({ status: "killed", workspaceRoot: daemon.workspaceRoot, pid: daemon.actor.pid })}\n`
            : `Killed daemon for ${daemon.workspaceRoot} (pid ${String(daemon.actor.pid)})\n`,
        });
        expect(elapsedMs).toBeGreaterThanOrEqual(3_500);
        expect(elapsedMs).toBeLessThan(6_500);
        expect((await navigation).status).toBe(1);
        expect(await daemon.exited).toBe(0);
        await E2eProcessCleanup.waitForExit([daemon.actor.pid!]);
        expect(new CliDaemonTesting(stateDir).inspector.listInstances()).toEqual([]);
      });
    },
    15_000,
  );

  it("stops the selected workspace and succeeds again when absent", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const started = runSymnavBinary(["daemon", "start"], {
      cwd,
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    expect(started).toMatchObject({ status: 0, stderr: "" });
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
    const events = daemonLogEvents(stateDir, cwd);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "start" }),
        expect.objectContaining({ kind: "ready" }),
        expect.objectContaining({ kind: "request-accepted", command: "version" }),
        expect.objectContaining({ kind: "execution-terminal", outcome: "completed" }),
        expect.objectContaining({ kind: "startup-completed" }),
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
  pids.push(...new CliDaemonTesting(stateDir).processIds());
}

function daemonLogEvents(
  stateDir: string,
  workspaceRoot: string,
): readonly Record<string, unknown>[] {
  return new CliDaemonTesting(stateDir).inspector.readDiagnostics(
    canonicalWorkspaceRoot(realpathSync(workspaceRoot)),
  ).events;
}
