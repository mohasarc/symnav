import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary, type RunSymnavBinaryResult } from "@symnav/testing";
import type { ChildProcess } from "node:child_process";
import { DAEMON_PROTOCOL_VERSION, type DaemonRecord } from "../../../src/daemon/daemon-protocol.js";
import { DaemonRegistry } from "../../../src/daemon/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../../src/daemon/daemon-workspace-identity.js";
import { LocalDaemonTransport } from "../../../src/daemon/local-daemon-transport.js";
import { createDefaultDependencies } from "../../../src/program.js";

describe("symnav daemon parity", () => {
  const harnesses: DaemonParityHarness[] = [];

  afterEach(() => {
    for (const harness of harnesses) harness.dispose();
    harnesses.length = 0;
  });

  it.each([
    ["text success", ["overview", "input.ts"]],
    ["json success", ["overview", "input.ts", "--json"]],
    ["resolve", ["resolve", "target"]],
    ["definition", ["def", "input.ts::target"]],
    ["references", ["refs", "input.ts::target", "--all"]],
    ["context", ["context", "input.ts::target"]],
    ["graph", ["graph", "input.ts::target"]],
    ["extraction warning", ["overview", "warning.ts"]],
    ["command usage error", ["def"]],
    ["user error", ["overview", "missing.ts"]],
    ["not found", ["resolve", "unknown"]],
    ["cwd-shaped target after separator", ["resolve", "--", "--cwd=target"]],
    ["help-shaped target after separator", ["resolve", "--", "--help"]],
    ["version-shaped target after separator", ["resolve", "--", "--version"]],
    ["help", ["--help"]],
    ["version", ["--version"]],
    ["stats", ["stats", "--json"]],
  ])("keeps %s bytes and status identical", (_name, args) => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);

    expect(harness.warm(args)).toEqual(harness.cold(args));
  });

  it("resolves relative --cwd from the requesting client directory", () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    harness.warm(["overview", "input.ts"]);
    const nestedDirectory = join(harness.workspaceRoot, "nested");
    mkdirSync(nestedDirectory);
    const args = ["--cwd", "..", "overview", "input.ts"];

    expect(harness.warmFrom(nestedDirectory, args)).toEqual(
      harness.coldFrom(nestedDirectory, args),
    );
  });

  it("uses the final repeated cwd from a client directory different from daemon launch", () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    const launcherDirectory = join(harness.workspaceRoot, "launcher");
    const clientDirectory = join(harness.workspaceRoot, "client");
    mkdirSync(launcherDirectory);
    mkdirSync(clientDirectory);
    harness.warmFrom(launcherDirectory, ["--cwd", "..", "overview", "input.ts"]);
    const daemonPid = harness.onlyDaemonPid();
    const args = ["--cwd=../ignored", "--cwd", "..", "overview", "input.ts"];

    expect(harness.warmFrom(clientDirectory, args)).toEqual(
      harness.coldFrom(clientDirectory, args),
    );
    expect(harness.onlyDaemonPid()).toBe(daemonPid);
  });
  it("elects one daemon when two commands start together", async () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    const expected = harness.cold(["overview", "input.ts"]);

    const results = await Promise.all([
      harness.warmAsync(["overview", "input.ts"]),
      harness.warmAsync(["overview", "input.ts"]),
    ]);

    expect(results).toEqual([expected, expected]);
    expect(harness.onlyDaemonPid()).toBeGreaterThan(0);
  });
  it("records only fallback when execution finishes but response delivery fails", async () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    const controlled = await harness.startControlledDaemon("--oversized-response");

    expect(harness.warmWithTelemetry(["overview", "input.ts"])).toEqual(
      harness.cold(["overview", "input.ts"]),
    );
    expect(existsSync(`${controlled.requestStartedPath}.1`)).toBe(true);
    expect(harness.telemetryModes()).toEqual(["fallback"]);
    expect(harness.daemonRecordCount()).toBe(0);
  }, 15_000);

  it("refreshes edits, additions, deletions, and renames before the next warm request", () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    harness.warm(["overview", "input.ts"]);

    writeFileSync(join(harness.workspaceRoot, "input.ts"), "export const edited = 2;\n");
    expect(harness.warm(["overview", "input.ts"])).toEqual(harness.cold(["overview", "input.ts"]));

    writeFileSync(join(harness.workspaceRoot, "added.ts"), "export const added = 3;\n");
    expect(harness.warm(["overview", "added.ts"])).toEqual(harness.cold(["overview", "added.ts"]));

    unlinkSync(join(harness.workspaceRoot, "added.ts"));
    expect(harness.warm(["overview", "added.ts"])).toEqual(harness.cold(["overview", "added.ts"]));

    renameSync(join(harness.workspaceRoot, "input.ts"), join(harness.workspaceRoot, "renamed.ts"));
    expect(harness.warm(["overview", "renamed.ts"])).toEqual(
      harness.cold(["overview", "renamed.ts"]),
    );
  });

  it("executes distinguishable queued requests FIFO and refreshes at queue-turn start", async () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    const releasePath = join(harness.root, "release-first-request");
    const controlled = await harness.startControlledDaemon(releasePath);
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 10_000 });
    const first = transport.request(controlled.record.endpoint, {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: controlled.record.instanceId,
      requestId: "fifo-first",
      request: {
        argv: ["--version"],
        cwd: harness.workspaceRoot,
        telemetryEnabled: false,
        executionMode: "warm",
      },
    });
    await waitUntil(() => existsSync(`${controlled.requestStartedPath}.1`));
    const second = harness.warmAsync(["overview", "input.ts"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(`${controlled.requestStartedPath}.2`)).toBe(false);
    writeFileSync(join(harness.workspaceRoot, "input.ts"), "export const queuedEdit = 3;\n");
    writeFileSync(releasePath, "release");

    const firstResponse = await first;
    const secondResult = await second;

    expect(firstResponse).toMatchObject({ kind: "result", result: { exitCode: 0 } });
    await waitUntil(() => existsSync(`${controlled.requestStartedPath}.2`));
    expect(secondResult).toEqual(harness.cold(["overview", "input.ts"]));
    if (firstResponse.kind !== "result") throw new Error("Expected first FIFO result");
    expect(decodeFrames(firstResponse.result.frames)).toMatch(/^\d+\.\d+\.\d+/);
    expect(secondResult.stdout).toContain("queuedEdit");
  }, 15_000);

  it("routes stats through and reuses the workspace daemon", () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    harness.warm(["overview", "input.ts"]);
    const daemonPid = harness.onlyDaemonPid();

    expect(harness.warm(["stats", "--json"])).toEqual(harness.cold(["stats", "--json"]));
    expect(harness.onlyDaemonPid()).toBe(daemonPid);
  });
});

class DaemonParityHarness {
  readonly root = mkdtempSync(join(tmpdir(), "symnav-daemon-parity-"));
  readonly workspaceRoot = join(this.root, "workspace");
  private readonly stateDirectory = join(this.root, "state");

  constructor() {
    mkdirSync(join(this.workspaceRoot, ".git"), { recursive: true });
    writeFileSync(
      join(this.workspaceRoot, "input.ts"),
      'export function target(value: string): string { return value; }\nexport function caller(): string { return target("x"); }\n',
    );
    writeFileSync(
      join(this.workspaceRoot, "warning.ts"),
      'export function stillVisible(): string { return "ok"; }\n\n@orphaned\n',
    );
  }

  warm(args: readonly string[]): RunSymnavBinaryResult {
    return this.run(args, "1");
  }

  cold(args: readonly string[]): RunSymnavBinaryResult {
    return this.run(args, "0");
  }

  warmWithTelemetry(args: readonly string[]): RunSymnavBinaryResult {
    return this.run(args, "1", this.workspaceRoot, "1");
  }

  warmFrom(cwd: string, args: readonly string[]): RunSymnavBinaryResult {
    return this.run(args, "1", cwd);
  }

  coldFrom(cwd: string, args: readonly string[]): RunSymnavBinaryResult {
    return this.run(args, "0", cwd);
  }

  warmAsync(args: readonly string[]): Promise<RunSymnavBinaryResult> {
    const cliBinPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "dist",
      "cli.js",
    );
    return new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [cliBinPath, ...args], {
        cwd: this.workspaceRoot,
        env: this.environment("1"),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (status) => resolveResult({ status, stdout, stderr }));
    });
  }

  daemonStatus(): RunSymnavBinaryResult {
    return this.run(["daemon", "status"], "1");
  }

  async orphanStartupMutation(): Promise<void> {
    const controlledWorkspaceRoot = realpathSync(this.workspaceRoot);
    const readyPath = join(this.stateDirectory, "orphaned-mutation-ready");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
        fileURLToPath(new URL("../../helpers/daemon-startup-mutation-owner.ts", import.meta.url)),
        controlledWorkspaceRoot,
        this.stateDirectory,
        readyPath,
      ],
      { stdio: "ignore" },
    );
    await waitUntil(() => existsSync(readyPath));
    const mutationOwnerPid = Number(readFileSync(readyPath, "utf8"));
    process.kill(mutationOwnerPid, "SIGKILL");
    child.kill("SIGKILL");
    await waitUntil(() => !processIsAlive(mutationOwnerPid));
  }

  async startControlledDaemon(releaseArgument = "--no-release"): Promise<ControlledDaemon> {
    const controlledWorkspaceRoot = realpathSync(this.workspaceRoot);
    const identity = DaemonWorkspaceIdentity.from(controlledWorkspaceRoot, this.stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    const instanceId = "controlled-crash";
    const processToken = `${instanceId}-token`;
    const readyPath = join(this.stateDirectory, `${instanceId}-ready`);
    const requestStartedPath = join(this.stateDirectory, `${instanceId}-request`);
    const symnavVersion = createDefaultDependencies().symnavVersion;
    const lease = registry.acquireStartup(identity, instanceId);
    if (lease === undefined) throw new Error("Expected controlled daemon startup ownership");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
        fileURLToPath(new URL("../../helpers/workspace-daemon-stuck.ts", import.meta.url)),
        controlledWorkspaceRoot,
        this.stateDirectory,
        instanceId,
        processToken,
        readyPath,
        requestStartedPath,
        releaseArgument,
        symnavVersion,
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          SYMNAV_STATE_DIR: this.stateDirectory,
          SYMNAV_TELEMETRY: "1",
        },
      },
    );
    await waitUntil(() => existsSync(`${readyPath}.boot`));
    const daemonPid = Number(readFileSync(`${readyPath}.boot`, "utf8"));
    const record: DaemonRecord = {
      schemaVersion: 1,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion,
      workspaceRoot: controlledWorkspaceRoot,
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
    return { child, requestStartedPath, record: readyRecord };
  }

  onlyDaemonPid(): number {
    const recordsDirectory = join(this.stateDirectory, "daemons");
    const records = readdirSync(recordsDirectory).filter((name) => name.endsWith(".json"));
    expect(records).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(recordsDirectory, records[0]!), "utf8")) as {
      pid: number;
    };
    return record.pid;
  }

  daemonRecordCount(): number {
    const recordsDirectory = join(this.stateDirectory, "daemons");
    if (!existsSync(recordsDirectory)) return 0;
    return readdirSync(recordsDirectory).filter((name) => name.endsWith(".json")).length;
  }

  replaceStateDirectoryWithFile(): void {
    writeFileSync(this.stateDirectory, "invalid daemon state path");
  }

  telemetryModes(): readonly string[] {
    return readFileSync(join(this.stateDirectory, "usage.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => (JSON.parse(line) as { executionMode: string }).executionMode);
  }

  dispose(): void {
    try {
      process.kill(this.onlyDaemonPid(), "SIGTERM");
    } catch {}
    rmSync(this.root, { recursive: true, force: true });
  }

  private run(
    args: readonly string[],
    daemon: string,
    cwd = this.workspaceRoot,
    telemetry = "0",
  ): RunSymnavBinaryResult {
    return runSymnavBinary(args, {
      cwd,
      env: this.environment(daemon, telemetry),
    });
  }

  private environment(daemon: string, telemetry = "0"): NodeJS.ProcessEnv {
    return {
      ...process.env,
      SYMNAV_DAEMON: daemon,
      SYMNAV_STATE_DIR: this.stateDirectory,
      SYMNAV_TELEMETRY: telemetry,
    };
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function decodeFrames(frames: readonly { readonly bytesBase64: string }[]): string {
  return frames.map((frame) => Buffer.from(frame.bytesBase64, "base64").toString()).join("");
}

interface ControlledDaemon {
  readonly child: ChildProcess;
  readonly record: DaemonRecord;
  readonly requestStartedPath: string;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for controlled daemon state");
}
