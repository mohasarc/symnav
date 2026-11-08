import { describe, it } from "vitest";
import { FixtureRunner } from "../fixture-runner.js";
import { ErrorOutput } from "./error-output.js";

const targetFixture = new FixtureRunner("target-pattern-cases");

describe("pagination error paths", () => {
  it.each([
    ["refs-page-out-of-range", ["refs", "helper", "--page", "99"]],
    ["refs-page-not-positive", ["refs", "helper", "--page", "0"]],
    ["refs-page-not-a-number", ["refs", "helper", "--page", "abc"]],
    ["refs-page-size-not-positive", ["refs", "helper", "--page-size", "0"]],
    ["refs-page-size-not-a-number", ["refs", "helper", "--page-size", "abc"]],
    ["pagination-all-with-page", ["refs", "helper", "--all", "--page", "2"]],
    ["graph-page-out-of-range", ["graph", "helper", "--page", "99"]],
    ["graph-page-size-below-both-directions", ["graph", "helper", "--page-size", "1"]],
    ["pagination-all-with-page", ["graph", "helper", "--all", "--page", "2"]],
  ])("%s", async (snapshotName, args) => {
    await ErrorOutput.expectSnapshot(targetFixture.run(args), snapshotName);
  });
});
