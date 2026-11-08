import { describe, it } from "vitest";
import { FixtureRunner } from "../fixture-runner.js";
import { ErrorOutput } from "./error-output.js";

const targetFixture = new FixtureRunner("target-pattern-cases");

describe("graph error paths", () => {
  it.each([
    ["graph-depth-exceeded", ["--depth", "99"]],
    ["graph-depth-not-positive", ["--depth", "0"]],
    ["graph-depth-not-a-number", ["--depth", "abc"]],
    ["graph-incoming-with-outgoing", ["--incoming", "--outgoing"]],
  ])("%s", async (snapshotName, args) => {
    await ErrorOutput.expectSnapshot(targetFixture.run(["graph", "helper", ...args]), snapshotName);
  });
});
