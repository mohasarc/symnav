import { describe, it } from "vitest";
import { FixtureRunner } from "../fixture-runner.js";
import { symbolCommands } from "../symbol-command.js";
import { ErrorOutput } from "./error-output.js";

const targetFixture = new FixtureRunner("target-pattern-cases");
const noSupportedFilesFixture = new FixtureRunner("no-supported-files-cases");

const targetErrorCases: readonly (readonly [string, readonly string[]])[] = [
  ["target-not-found", ["missing"]],
  ["target-ambiguous", ["PaymentProcessor::charge"]],
  ["target-line-mismatch", ["helper", "--line", "99"]],
  ["target-line-not-positive", ["helper", "--line", "0"]],
  ["target-empty", [""]],
  ["target-empty-segment", ["::charge"]],
  ["target-invalid-disambiguator", ["charge#abc"]],
  ["invalid-regex", ["--regex", "["]],
  ["target-file-not-found", ["missing.ts::charge"]],
  ["target-ignored-file", ["ignored-stuff.ts::HiddenProcessor"]],
];

describe("symbol target error paths", () => {
  describe.each(symbolCommands)("%s", (command) => {
    it.each(targetErrorCases)("%s", async (snapshotName, targetArgs) => {
      await ErrorOutput.expectSnapshot(targetFixture.run([command, ...targetArgs]), snapshotName);
    });

    it("no-supported-files", async () => {
      await ErrorOutput.expectSnapshot(
        noSupportedFilesFixture.run([command, "anything"]),
        "no-supported-files",
      );
    });
  });
});
