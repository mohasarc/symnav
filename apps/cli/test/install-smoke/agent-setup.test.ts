import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { E2eProcessCleanup } from "../helpers/e2e-process-cleanup.js";
import { InstallSmokeEnvironment } from "./install-smoke-environment.js";
import { InstalledSymnav } from "./installed-symnav.js";

describe("installed symnav agent setup", () => {
  const runRoot = realpathSync(mkdtempSync(join(tmpdir(), "symnav-install-smoke-")));
  const stateDirectory = join(runRoot, "state");
  const agentEnvironment: NodeJS.ProcessEnv = {
    CODEX_HOME: join(runRoot, "codex"),
    CLAUDE_CONFIG_DIR: join(runRoot, "claude"),
  };
  const symnav = new InstalledSymnav({
    prefix: InstallSmokeEnvironment.installPrefix(),
    stateDirectory,
    workspaceDirectory: InstallSmokeEnvironment.repositoryRoot,
    daemon: "cold",
  });

  afterAll(() => E2eProcessCleanup.removeDirectories([runRoot]));

  it("grants codex write access to the state directory", () => {
    const result = symnav.run(["setup", "codex"], agentEnvironment);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(runRoot, "codex", "config.toml"), "utf8")).toContain(
      JSON.stringify(stateDirectory),
    );
  });

  it("grants claude-code write access to the state directory", () => {
    const result = symnav.run(["setup", "claude-code"], agentEnvironment);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(runRoot, "claude", "settings.json"), "utf8")).toContain(
      JSON.stringify(stateDirectory),
    );
  });
});
