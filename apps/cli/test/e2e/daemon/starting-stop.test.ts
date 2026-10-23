import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary, type RunSymnavBinaryResult } from "@symnav/testing";
import { CliDaemonTesting } from "../../helpers/daemon-testing.js";
import { canonicalWorkspaceRoot } from "../../helpers/canonical-workspace-root.js";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";

class StartingStopHarness {
  public readonly root = realpathSync(mkdtempSync(join(tmpdir(), "symnav-built-starting-stop-")));
  public readonly stateDirectory = join(this.root, "state");
  public readonly workspace = canonicalWorkspaceRoot(join(this.root, "workspace"));
  public readonly testing = new CliDaemonTesting(this.stateDirectory);
  private readonly children = new Map<ChildProcess, Promise<RunSymnavBinaryResult>>();

  public constructor() {
    mkdirSync(this.stateDirectory);
    mkdirSync(join(this.workspace, ".git"), { recursive: true });
  }

  public async launch(worker: "graceful" | "blocked"): Promise<void> {
    const fixture = fileURLToPath(
      new URL("../../helpers/daemon-lifecycle-fixture.mjs", import.meta.url),
    );
    expect(await this.run(fixture, [], { SYMNAV_TEST_STARTING_STOP: worker })).toEqual({
      status: 0,
      stdout: "cold\n",
      stderr: "",
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(this.stateDirectory, "lifecycle-worker-started"))) {
      if (Date.now() >= deadline) throw new Error("Built lifecycle worker did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  public stop(): Promise<RunSymnavBinaryResult> {
    return this.run(fileURLToPath(new URL("../../../dist/cli.js", import.meta.url)), [
      "daemon",
      "stop",
    ]);
  }

  public async releaseDrainingWorker(): Promise<void> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const status = runSymnavBinary(["daemon", "status", "--json"], {
        cwd: this.workspace,
        env: { SYMNAV_STATE_DIR: this.stateDirectory },
      });
      const daemons = (JSON.parse(status.stdout) as { daemons: { detail?: string }[] }).daemons;
      if (daemons.some((daemon) => daemon.detail === "draining")) {
        writeFileSync(join(this.stateDirectory, "lifecycle-worker-release"), "released");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Built starting daemon did not begin authenticated drain");
  }

  public async dispose(): Promise<void> {
    expect(await this.stop()).toMatchObject({ status: 0, stderr: "" });
    if (process.platform !== "win32")
      expect(
        this.testing.inspector
          .processLifetimeObservations()
          .every((observation) => observation === "exited"),
      ).toBe(true);
    for (const [child, exited] of this.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    }
    E2eProcessCleanup.removeDirectories([this.root]);
  }

  private run(
    script: string,
    argv: readonly string[],
    environment: NodeJS.ProcessEnv = {},
  ): Promise<RunSymnavBinaryResult> {
    const child = spawn(process.execPath, [script, ...argv], {
      cwd: this.workspace,
      env: {
        ...process.env,
        SYMNAV_STATE_DIR: this.stateDirectory,
        SYMNAV_TELEMETRY: "0",
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<RunSymnavBinaryResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (bytes: Buffer) => {
        stdout += bytes.toString();
      });
      child.stderr.on("data", (bytes: Buffer) => {
        stderr += bytes.toString();
      });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });
    this.children.set(child, exited);
    return exited;
  }
}

describe("built starting daemon stop", () => {
  const harnesses: StartingStopHarness[] = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.dispose();
  });

  it.each(["graceful", "blocked"] as const)(
    "reports exact lifecycle output for a %s worker",
    async (worker) => {
      const harness = new StartingStopHarness();
      harnesses.push(harness);
      await harness.launch(worker);
      const instances = harness.testing.inspector.listInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0]?.state).toBe("starting");
      const stopping = harness.stop();
      if (worker === "graceful") await harness.releaseDrainingWorker();
      expect(await stopping).toEqual({
        status: 0,
        stderr: "",
        stdout: `${worker === "blocked" ? "Killed" : "Stopped"} daemon for ${harness.workspace} (pid ${instances[0]!.pid})\n`,
      });
      expect(harness.testing.inspector.listInstances()).toEqual([]);
      expect(await harness.stop()).toEqual({
        status: 0,
        stderr: "",
        stdout: `No daemon running for ${harness.workspace}\n`,
      });
    },
    15_000,
  );
});
