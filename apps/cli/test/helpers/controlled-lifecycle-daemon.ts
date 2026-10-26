import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DaemonStatusEnvelope } from "@symnav/daemon";
import { runSymnavBinary, type RunSymnavBinaryResult } from "@symnav/testing";
import { canonicalWorkspaceRoot } from "./canonical-workspace-root.js";
import { E2eProcessCleanup } from "./e2e-process-cleanup.js";

export interface ControlledLifecycleDiagnosticSnapshot {
  readonly pid: number | undefined;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly close:
    | { readonly state: "pending" }
    | {
        readonly state: "closed";
        readonly status: number | null;
        readonly signal: NodeJS.Signals | null;
      };
}

export class ControlledLifecycleDaemon {
  private readonly children: ChildProcess[] = [];
  private actorStderr = "";
  private readonly processToken: string;
  private close: ControlledLifecycleDiagnosticSnapshot["close"] = { state: "pending" };
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
    this.processToken = `${instanceId}-token`;
    this.readyPath = join(stateDirectory, `${instanceId}-actor-ready`);
    this.requestStartedPath = join(stateDirectory, `${instanceId}-request-started`);
    this.releasePath = join(stateDirectory, `${instanceId}-release`);
    const version = this.run(["--version"]).stdout.trim();
    this.actor = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
        fileURLToPath(
          new URL(
            "../../../../packages/daemon/test/actors/daemon-process-coordinator-controlled.ts",
            import.meta.url,
          ),
        ),
        this.workspaceRoot,
        stateDirectory,
        instanceId,
        this.processToken,
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
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          SYMNAV_STATE_DIR: stateDirectory,
          SYMNAV_TELEMETRY: "0",
          ...(diagnosticRecovery ? { SYMNAV_TEST_DIAGNOSTIC_RECOVERY: "1" } : {}),
        },
      },
    );
    this.actor.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      this.actorStderr = (this.actorStderr + chunk).slice(-16_384);
    });
    this.children.push(this.actor);
    this.exited = new Promise((resolve, reject) => {
      this.actor.once("error", reject);
      this.actor.once("close", (status, signal) => {
        this.close = { state: "closed", status, signal };
        resolve(status);
      });
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
        throw daemon.actorFailure("Controlled startup failure did not exit with failure");
      if (!existsSync(`${daemon.readyPath}.boot`))
        throw daemon.actorFailure("Controlled lifecycle actor exited before startup");
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

  public diagnosticSnapshot(): ControlledLifecycleDiagnosticSnapshot {
    return {
      pid: this.actor.pid,
      stderr: this.actorStderr.replaceAll(this.processToken, "[redacted]"),
      exitCode: this.actor.exitCode,
      signalCode: this.actor.signalCode,
      close: this.close,
    };
  }

  public async dispose(): Promise<void> {
    await E2eProcessCleanup.terminate([], this.children);
  }

  private actorFailure(message: string): Error {
    return new Error(
      `${message} (exit code ${String(this.actor.exitCode)}, signal ${String(this.actor.signalCode)}): ${this.actorStderr}`,
    );
  }

  private async waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (this.actor.exitCode !== null || this.actor.signalCode !== null) {
        await this.exited;
        throw this.actorFailure("Controlled lifecycle actor did not reach its barrier");
      }
      if (Date.now() > deadline)
        throw this.actorFailure("Controlled lifecycle actor did not reach its barrier");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
