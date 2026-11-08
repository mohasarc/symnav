import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { E2eProcessCleanup } from "../helpers/e2e-process-cleanup.js";
import { InstallSmokeEnvironment } from "./install-smoke-environment.js";
import { InstalledSymnav } from "./installed-symnav.js";
import { NavigationCommands } from "./navigation-commands.js";

describe("installed symnav cold navigation", () => {
  const runRoot = mkdtempSync(join(tmpdir(), "symnav-install-smoke-"));
  const symnav = new InstalledSymnav({
    prefix: InstallSmokeEnvironment.installPrefix(),
    stateDirectory: join(runRoot, "state"),
    workspaceDirectory: InstallSmokeEnvironment.repositoryRoot,
    daemon: "cold",
  });

  afterAll(() => E2eProcessCleanup.removeDirectories([runRoot]));

  it.each(NavigationCommands.AGAINST_REPOSITORY)(
    "%s %s answers from the repository",
    (command, target) => {
      const result = symnav.run([command, target]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("buildProgram");
    },
  );
});
