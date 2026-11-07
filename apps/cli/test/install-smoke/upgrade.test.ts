import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { E2eProcessCleanup } from "../helpers/e2e-process-cleanup.js";
import { InstallSmokeEnvironment } from "./install-smoke-environment.js";
import { InstalledSymnav } from "./installed-symnav.js";
import { UsageLog } from "./usage-log.js";

interface StatusDaemon {
  readonly state: string;
  readonly pid: number;
}

class UpgradedDaemonWatcher {
  private static readonly REPLACEMENT_TIMEOUT_MS = 120_000;
  private static readonly POLL_INTERVAL_MS = 500;

  constructor(private readonly symnav: InstalledSymnav) {}

  daemons(): readonly StatusDaemon[] {
    const status = this.symnav.run(["daemon", "status", "--json"]);
    expect(status.status, status.stderr).toBe(0);
    return (JSON.parse(status.stdout) as { daemons: readonly StatusDaemon[] }).daemons;
  }

  async waitForReadyReplacement(previousPid: number): Promise<readonly StatusDaemon[]> {
    const deadline = Date.now() + UpgradedDaemonWatcher.REPLACEMENT_TIMEOUT_MS;
    let daemons = this.daemons();
    while (Date.now() < deadline) {
      const replaced = daemons.some(
        (daemon) => daemon.state === "ready" && daemon.pid !== previousPid,
      );
      if (replaced) return daemons;
      await new Promise((resolve) => setTimeout(resolve, UpgradedDaemonWatcher.POLL_INTERVAL_MS));
      daemons = this.daemons();
    }
    return daemons;
  }
}

const previousTarball = InstallSmokeEnvironment.previousTarball();

describe.skipIf(previousTarball === undefined)(
  "installed symnav upgrade from the previous release",
  () => {
    const runRoot = mkdtempSync(join(tmpdir(), "symnav-upgrade-smoke-"));
    const stateDirectory = join(runRoot, "state");
    const symnav = new InstalledSymnav({
      prefix: join(runRoot, "prefix"),
      stateDirectory,
      workspaceDirectory: InstallSmokeEnvironment.repositoryRoot,
      daemon: "warm",
    });
    const watcher = new UpgradedDaemonWatcher(symnav);

    afterAll(async () => {
      await symnav.stopDaemons();
      E2eProcessCleanup.removeDirectories([runRoot]);
    });

    it("replaces the previous release's daemon with one on the new version", async () => {
      symnav.install(previousTarball!);
      const started = symnav.run(["daemon", "start"]);
      expect(started.status, started.stderr).toBe(0);
      const [previousDaemon] = watcher.daemons();
      expect(previousDaemon).toBeDefined();

      symnav.install(InstallSmokeEnvironment.tarball());
      const upgraded = symnav.run(["def", "buildProgram"]);
      expect(upgraded.status, upgraded.stderr).toBe(0);
      expect(new UsageLog(stateDirectory).events().at(-1)).toMatchObject({
        command: "def",
        executionMode: "fallback",
        symnavVersion: InstallSmokeEnvironment.expectedVersion(),
      });

      const daemons = await watcher.waitForReadyReplacement(previousDaemon!.pid);
      expect(daemons).toHaveLength(1);
      expect(daemons[0]!.state).toBe("ready");
      expect(daemons[0]!.pid).not.toBe(previousDaemon!.pid);
      await E2eProcessCleanup.waitForExit([previousDaemon!.pid]);

      const warm = symnav.run(["def", "buildProgram"]);
      expect(warm.status, warm.stderr).toBe(0);
      const lastEvent = new UsageLog(stateDirectory).events().at(-1);
      expect(lastEvent).toMatchObject({
        command: "def",
        executionMode: "warm",
        symnavVersion: InstallSmokeEnvironment.expectedVersion(),
      });
    });
  },
);
