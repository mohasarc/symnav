import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { createDefaultDependencies } from "../../../src/program.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "../../../src/daemon/daemon-protocol.js";
import { TestDaemonRegistry as DaemonRegistry } from "../../helpers/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../../src/daemon/daemon-workspace-identity.js";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "../../helpers/local-daemon-transport.js";
import { StateDirectoryResolver } from "../../../src/state-directory-resolver.js";
import { canonicalWorkspaceRoot } from "../../helpers/canonical-workspace-root.js";

describe("persistent daemon resource pressure", () => {
  const roots: string[] = [];
  const processes: ChildProcess[] = [];

  afterEach(() => {
    for (const child of processes) child.kill("SIGKILL");
    processes.length = 0;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("bounds replacement, preserves queued FIFO, and cleans exact ownership after exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-persistent-pressure-"));
    roots.push(root);
    const stateDirectory = StateDirectoryResolver.canonicalize(join(root, "state"));
    const workspaceRoot = join(root, "workspace");
    mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
    for (const filename of ["active.ts", "queued-one.ts", "queued-two.ts"]) {
      writeFileSync(join(workspaceRoot, filename), `export const value = "${filename}";\n`);
    }
    const identity = DaemonWorkspaceIdentity.from(
      canonicalWorkspaceRoot(realpathSync(workspaceRoot)),
      stateDirectory,
    );
    const registry = new DaemonRegistry(identity.registryDirectory);
    const instanceId = "persistent-pressure";
    const processToken = "persistent-pressure-token";
    const readyPath = join(stateDirectory, "pressure-ready");
    const requestStartedPath = join(stateDirectory, "pressure-request-started");
    const pressurePath = join(stateDirectory, "pressure-enabled");
    const executionOrderPath = join(stateDirectory, "pressure-order");
    const lease = registry.acquireStartup(identity, instanceId);
    if (lease === undefined) throw new Error("Expected pressure daemon startup ownership");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
        fileURLToPath(
          new URL(
            "../../helpers/daemon-process-coordinator-persistent-pressure.ts",
            import.meta.url,
          ),
        ),
        identity.workspaceRoot,
        stateDirectory,
        instanceId,
        processToken,
        readyPath,
        requestStartedPath,
        pressurePath,
        executionOrderPath,
        createDefaultDependencies(identity.stateDirectory, DaemonPolicy.currentSystem())
          .symnavVersion,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    processes.push(child);
    const childOutput = captureChildOutput(child);
    await Promise.race([
      waitUntil(() => existsSync(`${readyPath}.boot`)),
      childOutput.then((output) => {
        throw new Error(`Pressure daemon exited before boot: ${JSON.stringify(output)}`);
      }),
    ]);
    const daemonPid = Number(readFileSync(`${readyPath}.boot`, "utf8"));
    const record: DaemonRecord = {
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: createDefaultDependencies(
        identity.stateDirectory,
        DaemonPolicy.currentSystem(),
      ).symnavVersion,
      workspaceRoot: identity.workspaceRoot,
      workspaceKey: identity.workspaceKey,
      stateKey: identity.stateKey,
      identityKey: identity.identityKey,
      instanceId,
      processToken,
      endpoint: identity.endpoint(instanceId),
      pid: daemonPid,
      state: "starting",
      startedAt: Date.now(),
      memoryCapBytes: 256 * 1024 * 1024,
    };
    expect(registry.writeStartingIfStartupOwner(identity, record)).toBe(true);
    await waitUntil(() => existsSync(readyPath));
    lease.release();
    const active = runCli(workspaceRoot, stateDirectory, ["overview", "active.ts"]);
    await waitUntil(() => existsSync(requestStartedPath));
    const queuedOne = runCli(workspaceRoot, stateDirectory, ["overview", "queued-one.ts"]);
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 1_000 });
    await waitUntil(async () => {
      const response = await transport.request(record.endpoint, {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId,
      });
      return response.kind === "pong" && response.queued === 1;
    });
    const queuedTwo = runCli(workspaceRoot, stateDirectory, ["overview", "queued-two.ts"]);
    await waitUntil(async () => {
      const response = await transport.request(record.endpoint, {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId,
      });
      return response.kind === "pong" && response.queued === 2;
    });

    writeFileSync(pressurePath, "hard");
    const [activeResult, queuedOneResult, queuedTwoResult] = await Promise.all([
      active,
      queuedOne,
      queuedTwo,
    ]);

    expect(activeResult).toEqual({
      status: 1,
      stdout: "",
      stderr: "Cannot answer: daemon workspace capacity exceeded.\n",
    });
    expect(readFileSync(executionOrderPath, "utf8").trim().split("\n")).toEqual([
      "overview active.ts@1",
      "overview queued-one.ts@2",
      "overview queued-two.ts@3",
    ]);
    expect(queuedOneResult).toEqual({
      status: 0,
      stdout: "worker generation 2\n",
      stderr: "",
    });
    expect(queuedTwoResult).toEqual({
      status: 0,
      stdout: "worker generation 3\n",
      stderr: "",
    });
    expect(registry.read(identity)).toMatchObject({ pid: daemonPid, instanceId, processToken });
    await waitForProcess(child);
    processes.splice(processes.indexOf(child), 1);
    expect(existsSync(record.endpoint)).toBe(false);
    expect(registry.read(identity)).toMatchObject({ pid: daemonPid, instanceId, processToken });
    expect(registry.removeIfProcess(identity, instanceId, processToken)).toBe(true);
    expect(registry.read(identity)).toBeUndefined();
    await expect(childOutput).resolves.toEqual({ stdout: "", stderr: "" });
    const usagePath = join(stateDirectory, "usage.jsonl");
    const executionModes = existsSync(usagePath)
      ? readFileSync(usagePath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { executionMode: string }).executionMode)
      : [];
    expect(executionModes).not.toContain("fallback");
  }, 15_000);
});

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(
  workspaceRoot: string,
  stateDirectory: string,
  args: readonly string[],
): Promise<CliResult> {
  const cliPath = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));
  return captureProcess(
    spawn(process.execPath, [cliPath, ...args], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        SYMNAV_DAEMON: "1",
        SYMNAV_STATE_DIR: stateDirectory,
        SYMNAV_TELEMETRY: "1",
      },
    }),
  );
}

function captureProcess(child: ChildProcess): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function captureChildOutput(child: ChildProcess): Promise<{ stdout: string; stderr: string }> {
  return captureProcess(child).then(({ stdout, stderr }) => ({ stdout, stderr }));
}

function waitForProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for persistent pressure state");
}
