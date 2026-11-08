import { describe, it } from "vitest";
import { FixtureRunner } from "../fixture-runner.js";
import { ErrorOutput } from "./error-output.js";

const overviewFixture = new FixtureRunner("overview-cases");

describe("overview error paths", () => {
  it.each([
    ["overview-unsupported-extension", ["unsupported.md"]],
    ["overview-no-extension", ["extensionless"]],
    ["overview-at-not-found", ["targeted-expansion.ts", "--at", "missing"]],
    ["overview-line-not-found", ["targeted-expansion.ts", "--line", "9999"]],
    ["overview-at-on-line-not-found", ["targeted-expansion.ts", "--at", "missing", "--line", "1"]],
    ["overview-at-ambiguous", ["targeted-expansion.ts", "--at", "describe"]],
    ["overview-line-ambiguous", ["line-narrowing.ts", "--line", "14"]],
    ["overview-depth-negative", ["targeted-expansion.ts", "--depth", "-1"]],
    ["overview-depth-not-a-number", ["targeted-expansion.ts", "--depth", "abc"]],
    ["overview-line-not-positive", ["targeted-expansion.ts", "--line", "0"]],
    ["overview-line-not-a-number", ["targeted-expansion.ts", "--line", "abc"]],
  ])("%s", async (snapshotName, args) => {
    await ErrorOutput.expectSnapshot(overviewFixture.run(["overview", ...args]), snapshotName);
  });
});
