import { describe, it } from "vitest";

import { FixtureRunner } from "../fixture-runner.js";
import { CommandOutput } from "./command-output.js";

const fixture = new FixtureRunner("javascript-commonjs-cases");

const commandCases: readonly (readonly [string, readonly string[]])[] = [
  ["refs-through-barrel", ["refs", "src/functions/gt.js::gt"]],
  ["context-exports-alias", ["context", "src/compare.js::compare"]],
  ["graph-incoming-through-barrel", ["graph", "src/functions/gt.js::default", "--incoming"]],
  ["context-constructor-function", ["context", "src/queue.js::makeQueue"]],
  ["refs-exports-property", ["refs", "src/lib/strings.js::parse"]],
  ["context-module-exports-method", ["context", "src/lib/padding.js::trim"]],
  ["graph-incoming-module-exports-member", ["graph", "src/lib/strings.js::format", "--incoming"]],
  ["context-declaration-twin", ["context", "src/lib/clock.d.ts::now"]],
  ["graph-incoming-member-alias", ["graph", "src/lib/strings.js::parse", "--incoming"]],
  ["context-module-exports-value-member", ["context", "src/lib/glob.js::glob::makeRe"]],
  ["graph-outgoing-define-property", ["graph", "src/tools.js::release", "--outgoing"]],
  ["context-conditional-module-exports-member", ["context", "src/lib/umd.js::picker::first"]],
  ["context-module-exports-class-static", ["context", "src/lib/shape.js::Shape::square"]],
  ["context-real-module-exports-member", ["context", "src/lib/setup.js::realLabel"]],
  ["context-shadowed-owner-parameter", ["context", "src/lib/setup.js::localLabel"]],
];

describe("CommonJS exports and constructor functions", () => {
  it.each(commandCases)("%s", async (snapshotName, args) => {
    await CommandOutput.expectSnapshot(
      fixture.run(args),
      `javascript-commonjs-cases-${snapshotName}`,
    );
  });
});
