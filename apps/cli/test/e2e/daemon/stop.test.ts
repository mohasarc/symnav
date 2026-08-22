import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
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
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";
import { DAEMON_PROTOCOL_VERSION, type DaemonRecord } from "../../../src/daemon/daemon-protocol.js";
import { DaemonRegistry } from "../../../src/daemon/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../../src/daemon/daemon-workspace-identity.js";
import { LocalDaemonTransport } from "../../../src/daemon/local-daemon-transport.js";
import { canonicalWorkspaceRoot } from "../../helpers/canonical-workspace-root.js";

describe("symnav daemon stop", () => {
  const stateDirectories: string[] = [];
  const daemonPids: number[] = [];
  const helperProcesses: ChildProcess[] = [];

  afterEach(() => {
    for (const pid of daemonPids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    daemonPids.length = 0;
    for (const child of helperProcesses) child.kill("SIGTERM");
    helperProcesses.length = 0;
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

  it("drains an in-flight request before the built stop command returns", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const releasePath = join(stateDir, "release-request");
    const runtime = await startControlledDaemon(
      stateDir,
      canonicalWorkspaceRoot(realpathSync(cwd)),
      releasePath,
    );
    helperProcesses.push(runtime.child);
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 10_000 });
    const execution = transport.request(runtime.record.endpoint, {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: runtime.record.instanceId,
      requestId: "built-drain",
      request: { argv: ["--version"], cwd, telemetryEnabled: false },
    });
    await waitUntil(() => existsSync(runtime.requestStartedPath));
    const stopping = runBuiltStop(cwd, stateDir);
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(releasePath, "release");

    const response = await execution;
    const stopped = await stopping;

    expect(response).toMatchObject({ kind: "result", result: { exitCode: 0 } });
    expect(stopped).toEqual({
      status: 0,
      stdout: expect.stringMatching(/^\{"status":"stopped"/),
      stderr: "",
    });
    await waitForProcess(runtime.child);
    helperProcesses.splice(helperProcesses.indexOf(runtime.child), 1);
  }, 15_000);

  it("force-kills stuck work before the built stop command renders success", async () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const runtime = await startControlledDaemon(
      stateDir,
      canonicalWorkspaceRoot(realpathSync(cwd)),
    );
    helperProcesses.push(runtime.child);
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 10_000 });
    void transport
      .request(runtime.record.endpoint, {
        kind: "execute",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: runtime.record.instanceId,
        requestId: "built-force",
        request: { argv: ["--version"], cwd, telemetryEnabled: false },
      })
      .catch(() => undefined);
    await waitUntil(() => existsSync(runtime.requestStartedPath));

    const stopped = await runBuiltStop(cwd, stateDir);

    expect(stopped).toEqual({
      status: 0,
      stdout: expect.stringMatching(/^\{"status":"killed"/),
      stderr: "",
    });
    expect(() => process.kill(runtime.record.pid, 0)).toThrow();
    await waitForProcess(runtime.child);
    helperProcesses.splice(helperProcesses.indexOf(runtime.child), 1);
  }, 15_000);
});

interface ControlledDaemon {
  readonly child: ChildProcess;
  readonly record: DaemonRecord;
  readonly requestStartedPath: string;
}

async function startControlledDaemon(
  stateDirectory: string,
  workspaceRoot: string,
  releasePath?: string,
): Promise<ControlledDaemon> {
  const identity = DaemonWorkspaceIdentity.from(workspaceRoot, stateDirectory);
  const registry = new DaemonRegistry(identity.registryDirectory);
  const instanceId = `controlled-${releasePath === undefined ? "forced" : "draining"}`;
  const processToken = `${instanceId}-token`;
  const readyPath = join(stateDirectory, `${instanceId}-ready`);
  const requestStartedPath = join(stateDirectory, `${instanceId}-request`);
  const lease = registry.acquireStartup(identity, instanceId);
  if (lease === undefined) throw new Error("Expected controlled daemon startup ownership");
  const child = spawn(
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
      ...(releasePath === undefined ? [] : [releasePath]),
    ],
    { stdio: "ignore" },
  );
  await waitUntil(() => existsSync(`${readyPath}.boot`));
  const daemonPid = Number(readFileSync(`${readyPath}.boot`, "utf8"));
  const record: DaemonRecord = {
    schemaVersion: 1,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "test",
    workspaceRoot,
    workspaceKey: identity.workspaceKey,
    instanceId,
    processToken,
    endpoint: identity.endpoint(instanceId),
    pid: daemonPid,
    state: "starting",
    startedAt: Date.now(),
    memoryCapBytes: Number.MAX_SAFE_INTEGER,
  };
  if (!registry.writeStartingIfStartupOwner(identity, record)) {
    throw new Error("Controlled daemon lost startup ownership");
  }
  await waitUntil(() => existsSync(readyPath));
  lease.release();
  const readyRecord = registry.read(identity);
  if (readyRecord?.state !== "ready") throw new Error("Controlled daemon did not become ready");
  return { child, record: readyRecord, requestStartedPath };
}

function runBuiltStop(
  cwd: string,
  stateDirectory: string,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../../../dist/cli.js", import.meta.url)), "daemon", "stop", "--json"],
    {
      cwd,
      env: { ...process.env, SYMNAV_STATE_DIR: stateDirectory, SYMNAV_TELEMETRY: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

function waitForProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`Controlled daemon exited with code ${String(child.exitCode)}`));
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Controlled daemon exited with code ${String(code)}`));
    });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for controlled daemon state");
}

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
