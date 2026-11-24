import { describe, it } from "vitest";

import { FixtureRunner } from "../fixture-runner.js";
import { CommandOutput } from "./command-output.js";

const fixture = new FixtureRunner("javascript-declaration-cases");

const declarationForms: readonly (readonly [string, string])[] = [
  ["export-property", "src/export-property.js::parse"],
  ["module-exports-property", "src/module-exports-property.js::format"],
  ["module-exports-object", "src/module-exports-object.js::build"],
  ["module-exports-default", "src/module-exports-default.js::default"],
  ["define-property", "src/define-property.js::version"],
  ["prototype-property", "src/prototype-property.js::Queue::push"],
  ["prototype-object", "src/prototype-object.js::Stack::peek"],
  ["static-property", "src/static-property.js::Registry::create"],
  ["namespace-property", "src/namespace-property.js::helpers::slug"],
  ["this-property", "src/this-property.js::Counter::label"],
  ["jsdoc-types", "src/jsdoc-types.js::Visitor"],
];

describe("JavaScript declaration forms", () => {
  it.each(declarationForms)("lists %s in overview", async (form) => {
    await CommandOutput.expectSnapshot(
      fixture.run(["overview", `src/${form}.js`, "--depth", "2"]),
      `javascript-declaration-cases-overview-${form}`,
    );
  });

  it.each(declarationForms)("resolves %s as a def target", async (form, target) => {
    await CommandOutput.expectSnapshot(
      fixture.run(["def", target]),
      `javascript-declaration-cases-def-${form}`,
    );
  });
});
