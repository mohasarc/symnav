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
