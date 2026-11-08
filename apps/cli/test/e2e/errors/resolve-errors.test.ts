import { describe, it } from "vitest";
import { FixtureRunner } from "../fixture-runner.js";
import { ErrorOutput } from "./error-output.js";

const targetFixture = new FixtureRunner("target-pattern-cases");
const noSupportedFilesFixture = new FixtureRunner("no-supported-files-cases");

describe("resolve error paths", () => {
  it("--regex with --fuzzy", async () => {
    await ErrorOutput.expectSnapshot(
      targetFixture.run(["resolve", "charge", "--regex", "--fuzzy"]),
      "resolve-regex-with-fuzzy",
    );
  });

  it("invalid --regex pattern", async () => {
    await ErrorOutput.expectSnapshot(
      targetFixture.run(["resolve", "--regex", "["]),
      "invalid-regex",
    );
  });

  it("workspace without supported files", async () => {
    await ErrorOutput.expectSnapshot(
      noSupportedFilesFixture.run(["resolve", "anything"]),
      "no-supported-files",
    );
  });
});
