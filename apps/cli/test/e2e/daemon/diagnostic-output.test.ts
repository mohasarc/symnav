import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";
import { canonicalWorkspaceRoot } from "../../helpers/canonical-workspace-root.js";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";
import { CliDaemonTesting } from "../../helpers/daemon-testing.js";

describe("daemon diagnostic output isolation", () => {
  const directories: string[] = [];
  const daemonPids: number[] = [];

  afterEach(async () => {
    await E2eProcessCleanup.kill(daemonPids);
    daemonPids.length = 0;
    E2eProcessCleanup.removeDirectories(directories);
    directories.length = 0;
  });

  it("keeps malicious detached output and uncaught errors outside rotated JSONL", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "symnav-daemon-output-state-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symnav-daemon-output-workspace-"));
    directories.push(stateDirectory, workspaceRoot);
    mkdirSync(join(workspaceRoot, ".git"));
    writeFileSync(join(workspaceRoot, "input.ts"), "export const value = 1;\n");
    const crashTrigger = join(stateDirectory, "crash-trigger");
    const secret = "/private/source/PaymentProcessor::charge?token=secret";
    const preloadPath = fileURLToPath(
      new URL("../../helpers/daemon-malicious-output.cjs", import.meta.url),
    );

    const started = runSymnavBinary(["daemon", "start"], {
      cwd: workspaceRoot,
      env: {
        SYMNAV_STATE_DIR: stateDirectory,
        NODE_OPTIONS: `--require=${preloadPath}`,
        SYMNAV_TEST_DAEMON_OUTPUT_SECRET: secret,
        SYMNAV_TEST_DAEMON_CRASH_TRIGGER: crashTrigger,
      },
    });
    const canonicalRoot = canonicalWorkspaceRoot(realpathSync(workspaceRoot));
    const testing = new CliDaemonTesting(stateDirectory);
    const instance = testing.inspector.listInstances()[0];

    expect(started.status).toBe(0);
    expect(instance).toBeDefined();
    daemonPids.push(instance!.pid);
    writeFileSync(crashTrigger, "crash");
    await waitUntil(() => !isProcessAlive(instance!.pid));

    const events = testing.inspector.readDiagnostics(canonicalRoot).events;
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events.filter((event) => event.kind === "process-termination")).toEqual([
      expect.objectContaining({
        terminationReason: "uncaught-exception",
        errorName: "Error",
      }),
    ]);
  }, 15_000);

  it.skipIf(process.platform === "win32")(
    "records one closed signal classification before exact ownership cleanup",
    async () => {
      const stateDirectory = mkdtempSync(join(tmpdir(), "symnav-daemon-signal-state-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "symnav-daemon-signal-workspace-"));
      directories.push(stateDirectory, workspaceRoot);
      mkdirSync(join(workspaceRoot, ".git"));
      writeFileSync(join(workspaceRoot, "input.ts"), "export const value = 1;\n");

      const started = runSymnavBinary(["daemon", "start"], {
        cwd: workspaceRoot,
        env: { SYMNAV_STATE_DIR: stateDirectory },
      });
      const canonicalRoot = canonicalWorkspaceRoot(realpathSync(workspaceRoot));
      const testing = new CliDaemonTesting(stateDirectory);
      const instance = testing.inspector.listInstances()[0];
      expect(started.status).toBe(0);
      expect(instance).toBeDefined();
      daemonPids.push(instance!.pid);

      process.kill(instance!.pid, "SIGTERM");
      await waitUntil(() => !isProcessAlive(instance!.pid));
      await waitUntil(() => testing.inspector.listInstances().length === 0);

      const events = testing.inspector.readDiagnostics(canonicalRoot).events;
      expect(events.filter((event) => event.kind === "process-termination")).toEqual([
        expect.objectContaining({ terminationReason: "signal", signal: "SIGTERM" }),
      ]);
    },
    15_000,
  );

  it("records one redacted unhandled rejection classification", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "symnav-daemon-rejection-state-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symnav-daemon-rejection-workspace-"));
    directories.push(stateDirectory, workspaceRoot);
    mkdirSync(join(workspaceRoot, ".git"));
    writeFileSync(join(workspaceRoot, "input.ts"), "export const value = 1;\n");
    const rejectionTrigger = join(stateDirectory, "rejection-trigger");
    const secret = "/private/source/RejectedSecret?token=secret";
    const preloadPath = fileURLToPath(
      new URL("../../helpers/daemon-malicious-output.cjs", import.meta.url),
    );

    const started = runSymnavBinary(["daemon", "start"], {
      cwd: workspaceRoot,
      env: {
        SYMNAV_STATE_DIR: stateDirectory,
        NODE_OPTIONS: `--require=${preloadPath}`,
        SYMNAV_TEST_DAEMON_OUTPUT_SECRET: secret,
        SYMNAV_TEST_DAEMON_REJECTION_TRIGGER: rejectionTrigger,
      },
    });
    const canonicalRoot = canonicalWorkspaceRoot(realpathSync(workspaceRoot));
    const testing = new CliDaemonTesting(stateDirectory);
    const instance = testing.inspector.listInstances()[0];
    expect(started.status).toBe(0);
    expect(instance).toBeDefined();
    daemonPids.push(instance!.pid);
    writeFileSync(rejectionTrigger, "reject");
    await waitUntil(() => !isProcessAlive(instance!.pid));

    const events = testing.inspector.readDiagnostics(canonicalRoot).events;
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events.filter((event) => event.kind === "process-termination")).toEqual([
      expect.objectContaining({
        terminationReason: "unhandled-rejection",
        errorName: "TypeError",
      }),
    ]);
  }, 15_000);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for malicious daemon exit");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
