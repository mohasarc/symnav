import { describe, it } from "vitest";

import { FixtureRunner } from "../fixture-runner.js";
import { CommandOutput } from "./command-output.js";

const fixture = new FixtureRunner("javascript-commonjs-cases");

const commandCases: readonly (readonly [string, readonly string[]])[] = [
  ["refs-through-barrel", ["refs", "src/functions/gt.js::gt"]],
  ["context-exports-alias", ["context", "src/compare.js::compare"]],
  ["graph-incoming-through-barrel", ["graph", "src/functions/gt.js::default", "--incoming"]],
  ["context-constructor-function", ["context", "src/queue.js::makeQueue"]],
];

describe("CommonJS exports and constructor functions", () => {
  it.each(commandCases)("%s", async (snapshotName, args) => {
    await CommandOutput.expectSnapshot(
      fixture.run(args),
      `javascript-commonjs-cases-${snapshotName}`,
    );
  });
});
