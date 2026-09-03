import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";
import {
  DAEMON_LOG_BACKUP_COUNT,
  DAEMON_LOG_ROTATE_BYTES,
} from "../../../src/daemon/daemon-logger.js";
import { DaemonRegistry } from "../../../src/daemon/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../../src/daemon/daemon-workspace-identity.js";
import { StateDirectoryResolver } from "../../../src/state-directory-resolver.js";
import { canonicalWorkspaceRoot } from "../../helpers/canonical-workspace-root.js";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";

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
    const identity = DaemonWorkspaceIdentity.from(
      canonicalWorkspaceRoot(realpathSync(workspaceRoot)),
      StateDirectoryResolver.canonicalize(stateDirectory),
    );
    const record = new DaemonRegistry(identity.registryDirectory).read(identity);

    expect(started.status).toBe(0);
    expect(record).toBeDefined();
    daemonPids.push(record!.pid);
    writeFileSync(crashTrigger, "crash");
    await waitUntil(() => !isProcessAlive(record!.pid));

    const logNames = readdirSync(identity.identityDirectory)
      .filter((name) => /^daemon\.log(?:\.\d+)?$/.test(name))
      .sort();
    expect(logNames).toContain("daemon.log");
    expect(logNames).not.toContain(`daemon.log.${DAEMON_LOG_BACKUP_COUNT + 1}`);
    expect(logNames.length).toBeLessThanOrEqual(DAEMON_LOG_BACKUP_COUNT + 1);
    const events: Record<string, unknown>[] = [];
    for (const name of logNames) {
      const path = join(identity.identityDirectory, name);
      expect(statSync(path).size).toBeLessThanOrEqual(DAEMON_LOG_ROTATE_BYTES);
      const contents = readFileSync(path, "utf8");
      expect(contents).not.toContain(secret);
      for (const line of contents.split("\n").filter((value) => value.length > 0)) {
        const event = JSON.parse(line) as Record<string, unknown>;
        events.push(event);
      }
    }
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
      const identity = DaemonWorkspaceIdentity.from(
        canonicalWorkspaceRoot(realpathSync(workspaceRoot)),
        StateDirectoryResolver.canonicalize(stateDirectory),
      );
      const registry = new DaemonRegistry(identity.registryDirectory);
      const record = registry.read(identity);
      expect(started.status).toBe(0);
      expect(record).toBeDefined();
      daemonPids.push(record!.pid);

      process.kill(record!.pid, "SIGTERM");
      await waitUntil(() => !isProcessAlive(record!.pid));
      await waitUntil(() => registry.read(identity) === undefined);

      const events = readdirSync(identity.identityDirectory)
        .filter((name) => /^daemon\.log(?:\.\d+)?$/.test(name))
        .flatMap((name) =>
          readFileSync(join(identity.identityDirectory, name), "utf8")
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        );
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
    const identity = DaemonWorkspaceIdentity.from(
      canonicalWorkspaceRoot(realpathSync(workspaceRoot)),
      StateDirectoryResolver.canonicalize(stateDirectory),
    );
    const registry = new DaemonRegistry(identity.registryDirectory);
    const record = registry.read(identity);
    expect(started.status).toBe(0);
    expect(record).toBeDefined();
    daemonPids.push(record!.pid);
    writeFileSync(rejectionTrigger, "reject");
    await waitUntil(() => !isProcessAlive(record!.pid));

    const contents = readdirSync(identity.identityDirectory)
      .filter((name) => /^daemon\.log(?:\.\d+)?$/.test(name))
      .map((name) => readFileSync(join(identity.identityDirectory, name), "utf8"))
      .join("");
    expect(contents).not.toContain(secret);
    const events = contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
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
