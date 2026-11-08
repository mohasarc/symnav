import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { ErrorOutput } from "./error-output.js";
import { ScratchWorkspace } from "./scratch-workspace.js";

const isWindows = process.platform === "win32";

class DoctorScratch {
  readonly workspace = new ScratchWorkspace("nested-workspace-cases");

  run(args: readonly string[]) {
    return this.workspace.run(args, {
      env: {
        CODEX_HOME: join(this.workspace.root, "codex"),
        CLAUDE_CONFIG_DIR: join(this.workspace.root, "claude"),
      },
    });
  }
}

describe("doctor error paths", () => {
  afterEach(() => ScratchWorkspace.disposeAll());

  it.each([
    ["doctor-unknown-agent", ["doctor", "bogus"]],
    ["doctor-excess-arguments", ["doctor", "codex", "extra"]],
  ])("%s", async (snapshotName, args) => {
    const scratch = new DoctorScratch();

    await ErrorOutput.expectSnapshot(scratch.run(args), snapshotName);
  });

  it.skipIf(isWindows)("state directory is a file", async () => {
    const scratch = new DoctorScratch();
    scratch.workspace.blockStateDirectory();

    await ErrorOutput.expectSnapshot(scratch.run(["doctor"]), "doctor-state-directory-is-file", {
      placeholders: scratch.workspace.placeholders(),
    });
  });
});
