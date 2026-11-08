import { describe, it } from "vitest";
import { FixtureRunner } from "../fixture-runner.js";
import { ErrorOutput } from "./error-output.js";

const targetFixture = new FixtureRunner("target-pattern-cases");

describe("stats error paths", () => {
  it.each([
    ["stats-unknown-option", ["stats", "--bogus"]],
    ["stats-excess-arguments", ["stats", "extra"]],
  ])("%s", async (snapshotName, args) => {
    await ErrorOutput.expectSnapshot(targetFixture.run(args), snapshotName);
  });
});
