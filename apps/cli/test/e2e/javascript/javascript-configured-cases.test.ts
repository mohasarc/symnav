import { describe, it } from "vitest";

import { FixtureRunner } from "../fixture-runner.js";
import { CommandOutput } from "./command-output.js";

const tsconfigFixture = new FixtureRunner("javascript-configured-cases");
const jsconfigFixture = new FixtureRunner("javascript-jsconfig-cases");

const tsconfigCases: readonly (readonly [string, readonly string[]])[] = [
  ["refs-through-paths", ["refs", "src/lib/math.js::add"]],
  ["refs-jsx", ["refs", "src/Badge.jsx::Badge"]],
  ["graph-js-through-ts", ["graph", "src/caller.js::run", "--outgoing", "--depth", "2"]],
];

const jsconfigCases: readonly (readonly [string, readonly string[]])[] = [
  ["refs-through-paths", ["refs", "src/util.js::slugify"]],
  ["context", ["context", "src/util.js::slugify"]],
];

describe("JavaScript files in a tsconfig.json project without allowJs", () => {
  it.each(tsconfigCases)("%s", async (snapshotName, args) => {
    await CommandOutput.expectSnapshot(
      tsconfigFixture.run(args),
      `javascript-configured-cases-${snapshotName}`,
    );
  });
});

describe("JavaScript files in a jsconfig.json project", () => {
  it.each(jsconfigCases)("%s", async (snapshotName, args) => {
    await CommandOutput.expectSnapshot(
      jsconfigFixture.run(args),
      `javascript-jsconfig-cases-${snapshotName}`,
    );
  });
});
