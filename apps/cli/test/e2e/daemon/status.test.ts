import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";
import { canonicalStateDir } from "@symnav/telemetry";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "../../../src/daemon/daemon-protocol.js";
import { DaemonRegistry } from "../../../src/daemon/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../../src/daemon/daemon-workspace-identity.js";
import { LocalDaemonTransport } from "../../../src/daemon/local-daemon-transport.js";
import { canonicalWorkspaceRoot } from "../../helpers/canonical-workspace-root.js";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";
import { DaemonStateFiles } from "../../helpers/daemon-state-files.js";

describe("symnav daemon status", () => {
  const stateDirectories: string[] = [];
  const daemonPids: number[] = [];
  const helperProcesses: ChildProcess[] = [];

  afterEach(async () => {
    await E2eProcessCleanup.terminate(daemonPids, helperProcesses);
    daemonPids.length = 0;
    helperProcesses.length = 0;
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
      [realpathSync(alpha), realpathSync(beta)]
        .map(canonicalWorkspaceRoot)
        .sort((left, right) => left.localeCompare(right)),
    );
  });

  it("reports starting only while the matching cross-process owner is live", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const workspaceRoot = temporaryWorkspace(stateDirectories);
    const readyPath = join(stateDir, "publisher-ready");
    const barrierPath = join(stateDir, "publisher-go");
    const resultPath = join(stateDir, "publisher-result");
    const publisher = spawnStartupPublisher(
      workspaceRoot,
      stateDir,
      readyPath,
      barrierPath,
      resultPath,
    );
    helperProcesses.push(publisher);
    await waitUntil(() => existsSync(readyPath));

    const starting = runSymnavBinary(["daemon", "status", "--json"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    expect(JSON.parse(starting.stdout)).toEqual([
      expect.objectContaining({ workspaceRoot, state: "starting", pid: 0 }),
    ]);

    writeFileSync(barrierPath, "go");
    await waitForProcess(publisher);
    helperProcesses.splice(helperProcesses.indexOf(publisher), 1);
    const stopped = runSymnavBinary(["daemon", "status", "--json"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    expect(JSON.parse(stopped.stdout)).toEqual([]);
  });

  it("keeps one armed child when its initiating caller is killed before PID publication", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const workspaceRoot = temporaryWorkspace(stateDirectories);
    const instanceId = "caller-exit";
    const processToken = "caller-exit-process";
    const bootPath = join(stateDir, "caller-exit-boot");
    const callerBarrierPath = join(stateDir, "caller-exit-spawned");
    const childReleasePath = join(stateDir, "caller-exit-release");
    const readyPath = join(stateDir, "caller-exit-ready");
    const caller = spawnCallerExitStartup(
      workspaceRoot,
      stateDir,
      instanceId,
      processToken,
      bootPath,
      readyPath,
      callerBarrierPath,
      childReleasePath,
    );
    helperProcesses.push(caller);
    await waitUntil(() => existsSync(callerBarrierPath));
    const childPid = Number(readFileSync(bootPath, "utf8"));
    daemonPids.push(childPid);
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, canonicalStateDir(stateDir));
    const registry = new DaemonRegistry(identity.registryDirectory);

    expect(registry.readStoredInstance(identity, instanceId)).toMatchObject({
      instanceId,
      processToken,
      pid: 0,
      state: "starting",
    });
    expect(registry.startupOwner(identity)).toMatchObject({ instanceId, processToken });
    expect(caller.kill("SIGKILL")).toBe(true);
    await waitForKilledProcess(caller);
    helperProcesses.splice(helperProcesses.indexOf(caller), 1);

    const starting = runSymnavBinary(["daemon", "status", "--json"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });

    expect(starting.status).toBe(0);
    expect(JSON.parse(starting.stdout)).toEqual([
      expect.objectContaining({
        workspaceRoot,
        state: "starting",
        instanceId,
        pid: 0,
      }),
    ]);
    expect(registry.startupOwner(identity)).toMatchObject({ instanceId, processToken });

    const laterStart = spawnDaemonStart(workspaceRoot, stateDir);
    helperProcesses.push(laterStart);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(laterStart.exitCode).toBeNull();
    expect(daemonRecords(stateDir)).toEqual([
      expect.objectContaining({ instanceId, processToken, pid: 0 }),
    ]);

    writeFileSync(childReleasePath, "go");
    await waitUntil(() => existsSync(readyPath));
    await waitForProcess(laterStart);
    helperProcesses.splice(helperProcesses.indexOf(laterStart), 1);
    const navigation = runSymnavBinary(["overview", "input.ts"], {
      cwd: workspaceRoot,
      env: { SYMNAV_DAEMON: "1", SYMNAV_STATE_DIR: stateDir },
    });
    const readyRecord = daemonRecords(stateDir)[0];

    expect(navigation.status).toBe(0);
    expect(navigation.stdout).toContain("value");
    expect(daemonRecords(stateDir)).toHaveLength(1);
    expect(readyRecord?.state).toBe("ready");
    expect(readyRecord?.pid).toBe(childPid);
    expect(readyRecord?.instanceId).toBe(instanceId);
    expect(readyRecord?.processToken).toBe(processToken);

    const stopped = runSymnavBinary(["daemon", "stop"], {
      cwd: workspaceRoot,
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    expect(stopped.status).toBe(0);
    expect(isProcessAlive(childPid)).toBe(false);
    expect(daemonRecords(stateDir)).toEqual([]);
  }, 15_000);

  it("cleans a stale current-schema record", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const started = runSymnavBinary(["daemon", "start"], {
      cwd,
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    expect(started.status).toBe(0);
    captureDaemonPids(stateDir, daemonPids);
    const originalRecord = daemonRecords(stateDir)[0];
    expect(originalRecord).toBeDefined();
    await E2eProcessCleanup.kill(daemonPids);
    await E2eProcessCleanup.waitForEndpointRelease(originalRecord!.endpoint);
    daemonPids.length = 0;
    const recordPath = DaemonStateFiles.matchingPaths(stateDir, ".json")[0];
    expect(recordPath).toBeDefined();
    const record = JSON.parse(readFileSync(recordPath!, "utf8")) as Record<string, unknown>;
    writeFileSync(recordPath!, JSON.stringify({ ...record, pid: 999_999_999 }));

    const status = runSymnavBinary(["daemon", "status"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    expect(status).toEqual({ stdout: "No daemons running.\n", stderr: "", status: 0 });
    expect(DaemonStateFiles.matchingPaths(stateDir, ".json")).toEqual([]);
    expect(existsSync(String(record.endpoint))).toBe(false);
  });

  it("reports a stuck live daemon promptly without replacing its process", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const workspaceRoot = temporaryWorkspace(stateDirectories);
    const instanceId = "stuck-status";
    const processToken = "stuck-status-process";
    const readyPath = join(stateDir, "stuck-ready");
    const requestStartedPath = join(stateDir, "stuck-request");
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, canonicalStateDir(stateDir));
    const registry = new DaemonRegistry(identity.registryDirectory);
    const lease = registry.acquireStartup(identity, instanceId);
    expect(lease).toBeDefined();
    const child = spawnStuckDaemon(
      workspaceRoot,
      stateDir,
      instanceId,
      processToken,
      readyPath,
      requestStartedPath,
    );
    helperProcesses.push(child);
    await waitUntil(() => existsSync(`${readyPath}.boot`));
    const daemonPid = Number(readFileSync(`${readyPath}.boot`, "utf8"));
    expect(
      registry.writeStartingIfStartupOwner(identity, {
        schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        symnavVersion: "0.1.0",
        workspaceRoot,
        workspaceKey: identity.workspaceKey,
        stateKey: identity.stateKey,
        identityKey: identity.identityKey,
        instanceId,
        processToken,
        endpoint: identity.endpoint(instanceId),
        pid: daemonPid,
        state: "starting",
        startedAt: Date.now(),
        memoryCapBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(true);
    await waitUntil(() => existsSync(readyPath));
    lease?.release();
    const originalRecord = daemonRecords(stateDir)[0];
    expect(originalRecord).toBeDefined();
    daemonPids.push(originalRecord!.pid);
    const transport = new LocalDaemonTransport({ executionRequestTimeoutMs: 5_000 });
    void transport
      .request(originalRecord!.endpoint, {
        kind: "execute",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId,
        requestId: "stuck-navigation",
        request: {
          argv: ["overview", "input.ts"],
          cwd: workspaceRoot,
          telemetryEnabled: false,
        },
      })
      .catch(() => undefined);
    await waitUntil(() => existsSync(requestStartedPath));

    const statusStartedAt = Date.now();
    const status = runSymnavBinary(["daemon", "status", "--json"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    const statusDurationMs = Date.now() - statusStartedAt;
    const recordsAfterStatus = daemonRecords(stateDir);

    expect(status.status).toBe(0);
    expect(statusDurationMs).toBeLessThan(1_000);
    expect(JSON.parse(status.stdout)).toEqual([
      expect.objectContaining({
        workspaceRoot,
        state: "busy",
        pid: originalRecord!.pid,
        currentCommand: "overview",
        queued: 0,
      }),
    ]);
    expect(recordsAfterStatus).toHaveLength(1);
    expect(recordsAfterStatus[0]?.pid).toBe(originalRecord!.pid);
    expect(recordsAfterStatus[0]?.instanceId).toBe(instanceId);
  });

  it("returns the cold workspace error and exits after workspace deletion", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symnav-deleted-workspace-"));
    stateDirectories.push(workspaceRoot);
    mkdirSync(join(workspaceRoot, ".git"));
    writeFileSync(join(workspaceRoot, "input.ts"), "export const value = 1;\n");
    const started = runSymnavBinary(["daemon", "start"], {
      cwd: workspaceRoot,
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    expect(started.status).toBe(0);
    const record = daemonRecords(stateDir)[0];
    expect(record).toBeDefined();
    daemonPids.push(record!.pid);
    E2eProcessCleanup.removeDirectories([workspaceRoot]);

    const cold = runSymnavBinary(["--cwd", workspaceRoot, "overview", "input.ts"], {
      cwd: tmpdir(),
      env: { SYMNAV_DAEMON: "0" },
    });
    const response = await new LocalDaemonTransport().request(record!.endpoint, {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: record!.instanceId,
      requestId: "deleted-workspace",
      request: {
        argv: ["overview", "input.ts"],
        cwd: workspaceRoot,
        telemetryEnabled: false,
      },
    });

    expect(response.kind).toBe("result");
    if (response.kind !== "result") throw new Error("Expected command result");
    expect(replay(response.result.frames, "stdout")).toBe(cold.stdout);
    expect(replay(response.result.frames, "stderr")).toBe(cold.stderr);
    expect(response.result.exitCode).toBe(cold.status);
    await waitUntil(() => {
      runSymnavBinary(["daemon", "status", "--json"], {
        cwd: tmpdir(),
        env: { SYMNAV_STATE_DIR: stateDir },
      });
      return daemonRecords(stateDir).length === 0;
    });
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

function spawnStartupPublisher(
  workspaceRoot: string,
  stateDirectory: string,
  readyPath: string,
  barrierPath: string,
  resultPath: string,
): ChildProcess {
  return spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
      fileURLToPath(new URL("../../helpers/daemon-startup-publisher.ts", import.meta.url)),
      workspaceRoot,
      stateDirectory,
      readyPath,
      barrierPath,
      resultPath,
    ],
    { stdio: "ignore" },
  );
}

function spawnStuckDaemon(
  workspaceRoot: string,
  stateDirectory: string,
  instanceId: string,
  processToken: string,
  readyPath: string,
  requestStartedPath: string,
): ChildProcess {
  return spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
      fileURLToPath(new URL("../../helpers/workspace-daemon-stuck.ts", import.meta.url)),
      workspaceRoot,
      stateDirectory,
      instanceId,
      processToken,
      readyPath,
      requestStartedPath,
      "--no-release",
      "0.1.0",
    ],
    { stdio: "ignore" },
  );
}

function spawnCallerExitStartup(
  workspaceRoot: string,
  stateDirectory: string,
  instanceId: string,
  processToken: string,
  bootPath: string,
  readyPath: string,
  callerBarrierPath: string,
  childReleasePath: string,
): ChildProcess {
  return spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
      fileURLToPath(new URL("../../helpers/daemon-startup-caller-exit.ts", import.meta.url)),
      workspaceRoot,
      stateDirectory,
      instanceId,
      processToken,
      bootPath,
      readyPath,
      callerBarrierPath,
      childReleasePath,
    ],
    { stdio: "ignore" },
  );
}

function spawnDaemonStart(workspaceRoot: string, stateDirectory: string): ChildProcess {
  return spawn(
    process.execPath,
    [fileURLToPath(new URL("../../../dist/cli.js", import.meta.url)), "daemon", "start"],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        SYMNAV_STATE_DIR: stateDirectory,
        SYMNAV_TELEMETRY: "0",
      },
      stdio: "ignore",
    },
  );
}

function waitForProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Startup publisher exited with code ${String(code)}`));
    });
  });
}

function waitForKilledProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || (code !== null && code !== 0)) resolve();
      else reject(new Error("Startup caller did not exit abruptly"));
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function captureDaemonPids(stateDir: string, pids: number[]): void {
  pids.push(...daemonRecords(stateDir).map((record) => record.pid));
}

function daemonRecords(stateDir: string): readonly DaemonRecord[] {
  return DaemonStateFiles.matchingPaths(stateDir, ".json").map(
    (path) => JSON.parse(readFileSync(path, "utf8")) as DaemonRecord,
  );
}

function replay(
  frames: readonly { readonly stream: "stdout" | "stderr"; readonly bytesBase64: string }[],
  stream: "stdout" | "stderr",
): string {
  return Buffer.concat(
    frames
      .filter((frame) => frame.stream === stream)
      .map((frame) => Buffer.from(frame.bytesBase64, "base64")),
  ).toString("utf8");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for daemon shutdown");
}
