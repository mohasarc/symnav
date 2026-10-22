import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";
import { canonicalWorkspaceRoot } from "../../helpers/canonical-workspace-root.js";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";
import { CliDaemonTesting } from "../../helpers/daemon-testing.js";
import { ControlledLifecycleDaemon } from "../../helpers/controlled-lifecycle-daemon.js";

describe("symnav daemon status", () => {
  const stateDirectories: string[] = [];
  const daemonPids: number[] = [];
  const controlledDaemons: ControlledLifecycleDaemon[] = [];

  afterEach(async () => {
    await Promise.all(controlledDaemons.splice(0).map((daemon) => daemon.dispose()));
    await E2eProcessCleanup.terminate(daemonPids, []);
    daemonPids.length = 0;
    E2eProcessCleanup.removeDirectories(stateDirectories);
    stateDirectories.length = 0;
  });

  it("reports controlled startup without waiting for warm-up or starting another process", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const daemon = await ControlledLifecycleDaemon.start(cwd, stateDir, "starting");
    controlledDaemons.push(daemon);
    const startedAt = Date.now();
    const text = daemon.run(["daemon", "status"]);
    expect(text).toMatchObject({ status: 0, stderr: "" });
    expect(text.stdout).toMatch(/pid \d+  starting \d+s/);
    expect(daemon.status().daemons).toEqual([
      expect.objectContaining({ state: "starting", pid: daemon.actor.pid }),
    ]);
    expect(new CliDaemonTesting(stateDir).processIds()).toEqual([daemon.actor.pid]);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("reports busy elapsed time and queued work without affecting accepted navigation", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const daemon = await ControlledLifecycleDaemon.start(cwd, stateDir);
    controlledDaemons.push(daemon);
    const active = daemon.runAsync(["overview", "input.ts"]);
    await daemon.waitForRequest();
    const queued = [
      daemon.runAsync(["overview", "input.ts"]),
      daemon.runAsync(["overview", "input.ts"]),
    ];
    await daemon.waitForStatus(
      (report) => report.daemons[0]?.state === "busy" && report.daemons[0].queued === 2,
    );
    const json = daemon.status();
    expect(json).toMatchObject({
      schemaVersion: 1,
      daemons: [{ state: "busy", command: "overview", elapsedMs: expect.any(Number), queued: 2 }],
    });
    const text = daemon.run(["daemon", "status"]);
    expect(text.stdout).toMatch(/busy overview  \d+s  queued 2/);
    expect(text.stdout).not.toContain("No daemons running");
    const events = new CliDaemonTesting(stateDir).inspector.readDiagnostics(
      daemon.workspaceRoot,
    ).events;
    expect(events.filter((event) => event.kind === "request-accepted")).toHaveLength(3);
    daemon.release();
    for (const result of await Promise.all([active, ...queued]))
      expect(result).toMatchObject({ status: 0, stderr: "" });
  });

  it("adds one actual fallback after a surviving client observes daemon death", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const daemon = await ControlledLifecycleDaemon.start(cwd, stateDir);
    controlledDaemons.push(daemon);
    daemon.actor.kill("SIGKILL");
    await daemon.exited;
    expect(daemon.run(["overview", "input.ts"])).toMatchObject({ status: 0, stderr: "" });
    expect(daemon.run(["daemon", "start"])).toMatchObject({ status: 0, stderr: "" });
    captureDaemonPids(stateDir, daemonPids);
    expect(daemon.run(["daemon", "status"]).stdout).toContain(
      "  1 fallback in last hour: process terminated\n",
    );
    expect(daemon.status()).toMatchObject({
      schemaVersion: 1,
      daemons: [
        expect.objectContaining({
          recentFallbacks: {
            count: 1,
            latest: expect.objectContaining({
              phase: "process spawn",
              reason: "process-terminated",
            }),
          },
        }),
      ],
    });
    const evidence = await new CliDaemonTesting(stateDir).inspector.readFailures(
      daemon.workspaceRoot,
    );
    expect(evidence.filter((event) => event.kind === "termination")).toHaveLength(1);
    expect(evidence.filter((event) => event.kind === "fallback")).toHaveLength(1);
  });

  it.each(["ready", "starting"] as const)(
    "retains proven-dead %s evidence across separate explicit start invocations",
    async (state) => {
      const stateDir = temporaryStateDirectory(stateDirectories);
      const cwd = temporaryWorkspace(stateDirectories);
      const daemon = await ControlledLifecycleDaemon.start(cwd, stateDir, state);
      controlledDaemons.push(daemon);
      const inspector = new CliDaemonTesting(stateDir).inspector;
      const [previous] = inspector.listInstances();
      daemon.actor.kill("SIGKILL");
      await daemon.exited;
      expect(daemon.run(["daemon", "start"])).toMatchObject({ status: 0, stderr: "" });
      captureDaemonPids(stateDir, daemonPids);
      const evidence = await inspector.readFailures(daemon.workspaceRoot);
      expect(evidence.filter((event) => event.instanceId === previous!.instanceId)).toEqual([
        expect.objectContaining({
          kind: state === "ready" ? "termination" : "startup-failure",
          failure: expect.objectContaining({ reason: "process-terminated" }),
        }),
      ]);
      expect(daemon.run(["daemon", "start"])).toMatchObject({ status: 0, stderr: "" });
      expect(
        (await inspector.readFailures(daemon.workspaceRoot)).filter(
          (event) => event.instanceId === previous!.instanceId,
        ),
      ).toHaveLength(1);
      expect(daemon.run(["daemon", "stop"])).toMatchObject({ status: 0, stderr: "" });
    },
  );

  it("restores warning-free telemetry on the healthy request after diagnostic writes recover", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const daemon = await ControlledLifecycleDaemon.start(cwd, stateDir, "ready", undefined, true);
    controlledDaemons.push(daemon);
    daemon.release();
    daemon.denyDiagnosticWrites();
    const run = () =>
      runSymnavBinary(["overview", "input.ts"], {
        cwd,
        env: { SYMNAV_STATE_DIR: stateDir, SYMNAV_DAEMON: "1", SYMNAV_TELEMETRY: "1" },
      });
    const denied = run();
    expect(denied.status).toBe(0);
    expect(denied.stderr).toContain(
      `symnav: warning: cannot write ${realpathSync(stateDir)} (EACCES)`,
    );
    expect(denied.stderr.split("symnav: warning:")).toHaveLength(2);
    expect(readFileSync(join(stateDir, "usage.jsonl"), "utf8")).toBe("");
    daemon.recoverDiagnosticWrites();
    const healthy = run();
    expect(healthy).toMatchObject({ status: 0, stdout: denied.stdout, stderr: "" });
    const events = readFileSync(join(stateDir, "usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      expect.objectContaining({ command: "overview", executionMode: "warm" }),
    ]);
    expect(new CliDaemonTesting(stateDir).processIds()).toEqual([daemon.actor.pid]);
  });

  it.each([false, true])(
    "retains startup evidence after registry removal with expired=%s",
    async (expired) => {
      const stateDir = temporaryStateDirectory(stateDirectories);
      const cwd = temporaryWorkspace(stateDirectories);
      const daemon = await ControlledLifecycleDaemon.start(
        cwd,
        stateDir,
        "startup-failure",
        expired ? Date.now() - 3_610_000 : undefined,
      );
      controlledDaemons.push(daemon);
      const inspector = new CliDaemonTesting(stateDir).inspector;
      expect(inspector.listInstances()).toEqual([]);
      expect(await inspector.readFailures(daemon.workspaceRoot)).toEqual([
        expect.objectContaining({
          kind: "startup-failure",
          failure: expect.objectContaining({
            phase: "warm-up",
            reason: "startup-failed",
            osCode: "EACCES",
          }),
        }),
      ]);
      const text = daemon.run(["daemon", "status"]);
      const json = daemon.status();
      expect(text).toMatchObject({ status: 0, stderr: "" });
      if (expired) {
        expect(text.stdout).toBe("No daemons running.\n");
        expect(json).toEqual({ schemaVersion: 1, daemons: [] });
      } else {
        expect(text.stdout).toMatch(
          /No daemons running\.\n.+  last startup failed \d+s ago: startup failed \(EACCES\)\n/,
        );
        expect(json).toMatchObject({
          schemaVersion: 1,
          daemons: [],
          startupFailures: [
            {
              workspaceRoot: daemon.workspaceRoot,
              failure: expect.objectContaining({ osCode: "EACCES" }),
            },
          ],
        });
      }
      const otherState = temporaryStateDirectory(stateDirectories);
      expect(
        runSymnavBinary(["daemon", "status", "--json"], {
          cwd,
          env: { SYMNAV_STATE_DIR: otherState },
        }).stdout,
      ).toBe('{"schemaVersion":1,"daemons":[]}\n');
    },
  );

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
