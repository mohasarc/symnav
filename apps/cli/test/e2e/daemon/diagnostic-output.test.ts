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
import { canonicalStateDir } from "@symnav/telemetry";
import {
  DAEMON_LOG_BACKUP_COUNT,
  DAEMON_LOG_ROTATE_BYTES,
} from "../../../src/daemon/daemon-logger.js";
import { DaemonRegistry } from "../../../src/daemon/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../../src/daemon/daemon-workspace-identity.js";
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
      canonicalStateDir(stateDirectory),
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
    for (const name of logNames) {
      const path = join(identity.identityDirectory, name);
      expect(statSync(path).size).toBeLessThanOrEqual(DAEMON_LOG_ROTATE_BYTES);
      const contents = readFileSync(path, "utf8");
      expect(contents).not.toContain(secret);
      for (const line of contents.split("\n").filter((value) => value.length > 0)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
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
