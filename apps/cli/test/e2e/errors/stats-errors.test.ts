import { afterEach, describe, it } from "vitest";
import { FixtureRunner } from "../fixture-runner.js";
import { ErrorOutput, OPERATION_FAILURE_EXIT_CODE } from "./error-output.js";
import { ScratchWorkspace } from "./scratch-workspace.js";

const targetFixture = new FixtureRunner("target-pattern-cases");

const isWindows = process.platform === "win32";

describe("stats error paths", () => {
  afterEach(() => ScratchWorkspace.disposeAll());

  it.each([
    ["stats-unknown-option", ["stats", "--bogus"]],
    ["stats-excess-arguments", ["stats", "extra"]],
  ])("%s", async (snapshotName, args) => {
    await ErrorOutput.expectSnapshot(targetFixture.run(args), snapshotName);
  });

  it.skipIf(isWindows)("stats when the state directory is a file", async () => {
    const scratch = new ScratchWorkspace("nested-workspace-cases");
    scratch.blockStateDirectory();

    await ErrorOutput.expectSnapshot(
      scratch.run(["stats"], { env: { SYMNAV_TELEMETRY: "1" } }),
      "stats-state-directory-is-file",
      { exitCode: OPERATION_FAILURE_EXIT_CODE, placeholders: scratch.placeholders() },
    );
  });
});
