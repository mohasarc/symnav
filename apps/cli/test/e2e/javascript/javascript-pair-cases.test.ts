import { describe, it } from "vitest";

import { FixtureRunner } from "../fixture-runner.js";
import { CommandOutput } from "./command-output.js";

const fixture = new FixtureRunner("javascript-pair-cases");

const commandCases: readonly (readonly [string, readonly string[]])[] = [
  ["refs-implementation", ["refs", "src/Tabs/Tabs.js::Tabs"]],
  ["refs-bare-name", ["refs", "Tabs"]],
  ["def-implementation", ["def", "src/Tabs/Tabs.js::Tabs"]],
  ["def-declaration", ["def", "src/Tabs/Tabs.d.ts::Tabs"]],
  ["def-commonjs", ["def", "src/cjs/util.js::helper"]],
  ["context-implementation", ["context", "src/Tabs/Tabs.js::Tabs"]],
  ["graph-declaration", ["graph", "src/Tabs/Tabs.d.ts::Tabs"]],
  ["graph-into-pair", ["graph", "src/hooks/useTabs.js::useTabs", "--outgoing"]],
];

describe("JavaScript files paired with .d.ts declarations", () => {
  it.each(commandCases)("%s", async (snapshotName, args) => {
    await CommandOutput.expectSnapshot(fixture.run(args), `javascript-pair-cases-${snapshotName}`);
  });
});
