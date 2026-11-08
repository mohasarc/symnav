import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { ErrorOutput } from "./error-output.js";
import { ScratchWorkspace } from "./scratch-workspace.js";

class SetupScratch {
  readonly workspace = new ScratchWorkspace("nested-workspace-cases");
  readonly codexHome = join(this.workspace.root, "codex");
  readonly claudeConfigurationDirectory = join(this.workspace.root, "claude");

  run(args: readonly string[]) {
    return this.workspace.run(args, {
      cwd: this.workspace.root,
      env: { CODEX_HOME: this.codexHome, CLAUDE_CONFIG_DIR: this.claudeConfigurationDirectory },
    });
  }
}

describe("setup error paths", () => {
  afterEach(() => ScratchWorkspace.disposeAll());

  it.each([
    ["setup-missing-agent", ["setup"]],
    ["setup-unknown-agent", ["setup", "bogus"]],
    ["setup-excess-arguments", ["setup", "codex", "extra"]],
  ])("%s", async (snapshotName, args) => {
    const scratch = new SetupScratch();

    await ErrorOutput.expectSnapshot(scratch.run(args), snapshotName);
  });

  it("codex with an invalid configuration file", async () => {
    const scratch = new SetupScratch();
    scratch.workspace.writeFile("../codex/config.toml", "[sandbox\n");

    await ErrorOutput.expectSnapshot(
      scratch.run(["setup", "codex"]),
      "setup-codex-invalid-configuration",
      { placeholders: scratch.workspace.placeholders() },
    );
  });

  it("claude-code with an invalid configuration file", async () => {
    const scratch = new SetupScratch();
    scratch.workspace.writeFile("../claude/settings.json", '{"a": 1,\n"a": 2}\n');

    await ErrorOutput.expectSnapshot(
      scratch.run(["setup", "claude-code"]),
      "setup-claude-code-invalid-configuration",
      { placeholders: scratch.workspace.placeholders() },
    );
  });
});
