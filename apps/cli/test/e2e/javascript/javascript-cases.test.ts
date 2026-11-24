import { describe, it } from "vitest";

import { FixtureRunner } from "../fixture-runner.js";
import { CommandOutput } from "./command-output.js";

const fixture = new FixtureRunner("javascript-cases");

const commandCases: readonly (readonly [string, readonly string[]])[] = [
  ["overview-js", ["overview", "src/Tabs/Tabs.js"]],
  ["overview-jsx", ["overview", "src/App.jsx"]],
  ["overview-mjs", ["overview", "src/lib.mjs"]],
  ["overview-cjs", ["overview", "src/legacy.cjs"]],
  ["resolve-all", ["resolve", "--regex", "^(?!HEAD$|config$|index$|exclude$|main$)[A-Za-z]+$"]],
  ["def-js", ["def", "src/Tabs/Tabs.js::createTabs"]],
  ["refs-js-from-ts", ["refs", "src/Tabs/Tabs.js::createTabs"]],
  ["refs-ts-from-js", ["refs", "src/format.ts::formatLabel"]],
  ["refs-jsx-element", ["refs", "src/Tabs/Tabs.js::Tabs"]],
  ["context-js", ["context", "src/Tabs/Tabs.js::createTabs"]],
  ["graph-js", ["graph", "src/Tabs/Tabs.js::createTabs"]],
  ["graph-mjs-to-cjs", ["graph", "src/lib.mjs::greet", "--outgoing"]],
];

describe("JavaScript files in an unconfigured workspace", () => {
  it.each(commandCases)("%s", async (snapshotName, args) => {
    await CommandOutput.expectSnapshot(fixture.run(args), `javascript-cases-${snapshotName}`);
  });
});
