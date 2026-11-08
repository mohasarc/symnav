import { describe, it } from "vitest";
import { FixtureRunner } from "../fixture-runner.js";
import { ErrorOutput } from "./error-output.js";

const targetFixture = new FixtureRunner("target-pattern-cases");

describe("option parsing error paths", () => {
  it.each([
    ["option-no-command", []],
    ["option-unknown-command", ["bogus"]],
    ["option-unknown-global-option", ["--bogus"]],
    ["option-unknown-command-option", ["def", "helper", "--bogus"]],
    ["option-missing-argument", ["def"]],
    ["option-excess-arguments", ["def", "helper", "extra"]],
    ["option-missing-global-option-value", ["--cwd"]],
    ["option-missing-command-option-value", ["refs", "helper", "--page"]],
  ])("%s", async (snapshotName, args) => {
    await ErrorOutput.expectSnapshot(targetFixture.run(args), snapshotName);
  });
});
