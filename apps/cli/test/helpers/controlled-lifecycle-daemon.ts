import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonStatusEnvelope } from "@symnav/daemon";
import { runSymnavBinary, type RunSymnavBinaryResult } from "@symnav/testing";
import { canonicalWorkspaceRoot } from "./canonical-workspace-root.js";
import { E2eProcessCleanup } from "./e2e-process-cleanup.js";

export class ControlledLifecycleDaemon {
  private readonly children: ChildProcess[] = [];
  private readonly readyPath: string;
  private readonly requestStartedPath: string;
  private readonly releasePath: string;
  public readonly workspaceRoot: string;
  public readonly actor: ChildProcess;
  public readonly exited: Promise<number | null>;

  private constructor(
    workspaceRoot: string,
    private readonly stateDirectory: string,
    mode: "ready" | "starting" | "startup-failure" | "stuck",
    timestamp?: number,
    diagnosticRecovery = false,
  ) {
    this.workspaceRoot = canonicalWorkspaceRoot(realpathSync(workspaceRoot));
    const instanceId = randomUUID();
    this.readyPath = join(stateDirectory, `${instanceId}-actor-ready`);
    this.requestStartedPath = join(stateDirectory, `${instanceId}-request-started`);
    this.releasePath = join(stateDirectory, `${instanceId}-release`);
    const version = this.run(["--version"]).stdout.trim();
    this.actor = spawn(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(
          new URL(
            "../../../../packages/daemon/test/actors/daemon-process-coordinator-controlled.ts",
            import.meta.url,
          ),
        ),
        this.workspaceRoot,
        stateDirectory,
        instanceId,
        `${instanceId}-token`,
        this.readyPath,
        this.requestStartedPath,
        mode === "ready" ? this.releasePath : mode === "stuck" ? "--no-release" : `--${mode}`,
        new URL(
          diagnosticRecovery
            ? "../../dist/daemon-executor.js"
            : "../../../../packages/daemon/test/fixtures/executor-module.mjs",
          import.meta.url,
        ).href,
        version,
        ...(timestamp === undefined ? [] : [String(timestamp)]),
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          SYMNAV_STATE_DIR: stateDirectory,
          SYMNAV_TELEMETRY: "0",
          ...(diagnosticRecovery ? { SYMNAV_TEST_DIAGNOSTIC_RECOVERY: "1" } : {}),
        },
      },
    );
    this.children.push(this.actor);
    this.exited = new Promise((resolve, reject) => {
      this.actor.once("error", reject);
      this.actor.once("exit", resolve);
    });
  }

  public static async start(
    workspaceRoot: string,
    stateDirectory: string,
    mode: "ready" | "starting" | "startup-failure" | "stuck" = "ready",
    timestamp?: number,
    diagnosticRecovery = false,
  ): Promise<ControlledLifecycleDaemon> {
    const daemon = new ControlledLifecycleDaemon(
      workspaceRoot,
      stateDirectory,
      mode,
      timestamp,
      diagnosticRecovery,
    );
    if (mode === "startup-failure") {
      if ((await daemon.exited) !== 1)
        throw new Error("Controlled startup failure did not exit with failure");
      return daemon;
    }
    await daemon.waitUntil(() =>
      existsSync(mode === "starting" ? `${daemon.readyPath}.boot` : daemon.readyPath),
    );
    return daemon;
  }

  public run(arguments_: readonly string[]): RunSymnavBinaryResult {
    return runSymnavBinary(arguments_, {
      cwd: this.workspaceRoot,
      env: { SYMNAV_STATE_DIR: this.stateDirectory, SYMNAV_DAEMON: "1", SYMNAV_TELEMETRY: "0" },
    });
  }

  public runAsync(arguments_: readonly string[]): Promise<RunSymnavBinaryResult> {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../dist/cli.js", import.meta.url)), ...arguments_],
      {
        cwd: this.workspaceRoot,
        env: { ...process.env, SYMNAV_STATE_DIR: this.stateDirectory, SYMNAV_TELEMETRY: "0" },
      },
    );
    this.children.push(child);
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (status) => resolve({ stdout, stderr, status }));
    });
  }

  public status(): DaemonStatusEnvelope {
    const status = this.run(["daemon", "status", "--json"]);
    if (status.status !== 0 || status.stderr !== "")
      throw new Error(`Lifecycle status failed: ${status.stderr}`);
    return JSON.parse(status.stdout) as DaemonStatusEnvelope;
  }

  public waitForRequest(): Promise<void> {
    return this.waitUntil(() => existsSync(this.requestStartedPath));
  }

  public waitForStatus(predicate: (status: DaemonStatusEnvelope) => boolean): Promise<void> {
    return this.waitUntil(() => predicate(this.status()));
  }

  public release(): void {
    writeFileSync(this.releasePath, "release");
  }

  public denyDiagnosticWrites(): void {
    writeFileSync(`${this.readyPath}.diagnostics-denied`, "denied");
  }

  public recoverDiagnosticWrites(): void {
    rmSync(`${this.readyPath}.diagnostics-denied`);
  }

  public async dispose(): Promise<void> {
    await E2eProcessCleanup.terminate([], this.children);
  }

  private async waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline || this.actor.exitCode !== null)
        throw new Error("Controlled lifecycle actor did not reach its barrier");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
