import { afterEach, describe, it } from "vitest";
import { ErrorOutput, OPERATION_FAILURE_EXIT_CODE } from "./error-output.js";
import { ScratchWorkspace } from "./scratch-workspace.js";

const WORKSPACE_ID_PATTERN = /[0-9a-f]{64}/g;
const isWindows = process.platform === "win32";

describe("daemon error paths", () => {
  afterEach(() => ScratchWorkspace.disposeAll());

  it("start with SYMNAV_DAEMON=0", async () => {
    const scratch = new ScratchWorkspace("nested-workspace-cases");

    await ErrorOutput.expectSnapshot(
      scratch.run(["daemon", "start"], { env: { SYMNAV_DAEMON: "0" } }),
      "daemon-start-disabled",
    );
  });

  it.each(["start", "stop"])("%s outside any Git workspace", async (action) => {
    const scratch = new ScratchWorkspace("nested-workspace-cases");

    await ErrorOutput.expectSnapshot(
      scratch.run(["daemon", action], { cwd: scratch.root }),
      "not-in-git-workspace",
      { placeholders: scratch.placeholders() },
    );
  });

  it.skipIf(isWindows).each(["start", "stop"])(
    "%s when the state directory is a file",
    async (action) => {
      const scratch = new ScratchWorkspace("nested-workspace-cases");
      scratch.blockStateDirectory();
      const result = scratch.run(["daemon", action]);

      await ErrorOutput.expectSnapshot(
        { ...result, stderr: result.stderr.replace(WORKSPACE_ID_PATTERN, "<workspace-id>") },
        `daemon-${action}-state-directory-is-file`,
        { exitCode: OPERATION_FAILURE_EXIT_CODE, placeholders: scratch.placeholders() },
      );
    },
  );

  it.each([
    ["daemon-unknown-subcommand", ["daemon", "bogus"]],
    ["daemon-start-excess-arguments", ["daemon", "start", "extra"]],
  ])("%s", async (snapshotName, args) => {
    const scratch = new ScratchWorkspace("nested-workspace-cases");

    await ErrorOutput.expectSnapshot(scratch.run(args), snapshotName);
  });
});
