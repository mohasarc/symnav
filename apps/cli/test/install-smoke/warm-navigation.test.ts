import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NavigationModeDaemonStatusDecoder } from "../e2e/run-navigation-mode.js";
import type { NavigationModeDaemon } from "../e2e/navigation-mode-cleanup.js";
import { E2eProcessCleanup } from "../helpers/e2e-process-cleanup.js";
import { InstallSmokeEnvironment } from "./install-smoke-environment.js";
import { InstalledSymnav } from "./installed-symnav.js";
import { NavigationCommands } from "./navigation-commands.js";
import { UsageLog } from "./usage-log.js";

describe("installed symnav warm navigation", () => {
  const runRoot = mkdtempSync(join(tmpdir(), "symnav-install-smoke-"));
  const warmStateDirectory = join(runRoot, "warm-state");
  const symnavOptions = {
    prefix: InstallSmokeEnvironment.installPrefix(),
    workspaceDirectory: InstallSmokeEnvironment.repositoryRoot,
  } as const;
  const cold = new InstalledSymnav({
    ...symnavOptions,
    stateDirectory: join(runRoot, "cold-state"),
    daemon: "cold",
  });
  const warm = new InstalledSymnav({
    ...symnavOptions,
    stateDirectory: warmStateDirectory,
    daemon: "warm",
  });

  beforeAll(() => {
    const started = warm.run(["daemon", "start"]);
    expect(started.status, started.stderr).toBe(0);
  });

  afterAll(async () => {
    await warm.stopDaemons();
    E2eProcessCleanup.removeDirectories([runRoot]);
  });

  it.each(NavigationCommands.AGAINST_REPOSITORY)(
    "%s %s answers the same as cold",
    (command, target) => {
      const coldResult = cold.run([command, target]);
      const warmResult = warm.run([command, target]);

      expect(warmResult.status, warmResult.stderr).toBe(0);
      expect(warmResult.stdout).toBe(coldResult.stdout);
    },
  );

  it("answers every navigation command warm on the expected version", () => {
    const navigationCommands = NavigationCommands.AGAINST_REPOSITORY.map(([command]) => command);
    const navigationEvents = new UsageLog(warmStateDirectory)
      .events()
      .filter((event) => navigationCommands.includes(event.command));

    expect(navigationEvents.map((event) => event.command)).toEqual(navigationCommands);
    for (const event of navigationEvents) {
      expect(event.executionMode).toBe("warm");
      expect(event.symnavVersion).toBe(InstallSmokeEnvironment.expectedVersion());
    }
  });

  it("lists the repository daemon in status", () => {
    const daemons = statusDaemons();

    expect(daemons.map((daemon) => realpathSync(daemon.workspaceRoot))).toEqual([
      realpathSync(InstallSmokeEnvironment.repositoryRoot),
    ]);
  });

  it("stops the daemon and lists none after", () => {
    const stopped = warm.run(["daemon", "stop"]);

    expect(stopped.status, stopped.stderr).toBe(0);
    expect(statusDaemons()).toEqual([]);
  });

  function statusDaemons(): readonly NavigationModeDaemon[] {
    const status = warm.run(["daemon", "status", "--json"]);
    expect(status.status, status.stderr).toBe(0);
    return NavigationModeDaemonStatusDecoder.decode(JSON.parse(status.stdout) as unknown);
  }
});
