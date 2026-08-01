import { describe, expect, it } from "vitest";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { extractFileEntries } from "./extract-file-entries.js";
import { FoldHeaderVariantsExtractor } from "./extract-fold-header-variants.js";

function firstStatementVariants(source: string): readonly string[] {
  const sourceFile = parseTypeScriptSource(source);
  const statement = sourceFile.getStatements()[0];
  if (!statement) throw new Error("expected a statement");
  return FoldHeaderVariantsExtractor.extract(statement);
}

describe("FoldHeaderVariantsExtractor", () => {
  it.each([
    ['describe("x", () => {\n  run();\n});', 'describe("x")'],
    ['describe("beta", async () => {\n  run();\n});', 'describe("beta")'],
    ['describe("gamma", (t) => {\n  run(t);\n});', 'describe("gamma")'],
    ['describe("d", function () {\n  run();\n});', 'describe("d")'],
    ['describe("e", async function () {\n  run();\n});', 'describe("e")'],
    ["run(() => {\n  work();\n});", "run()"],
    ["await run(async () => {\n  work();\n});", "await run()"],
  ])("closes the call form of %s", (source, closedForm) => {
    expect(firstStatementVariants(source)).toEqual([closedForm]);
  });

  it.each([
    ["try {\n  run();\n} catch {\n}", "try statement"],
    ["{\n  run();\n}", "block"],
    ["if (flag) {\n  run();\n}", "if statement"],
    ['switch (mode) {\n  case "a": {\n    run();\n  }\n}', "switch statement"],
  ])("produces no variants for %s (%s)", (source) => {
    expect(firstStatementVariants(source)).toEqual([]);
  });

  it("produces no variants for a call without a trailing callback body", () => {
    expect(firstStatementVariants("run(1, 2);")).toEqual([]);
  });
});

describe("fold header variants attachment", () => {
  function foldEntries(source: string) {
    const sourceFile = parseTypeScriptSource(source);
    return extractFileEntries({ sourceFile, filePath: "input.ts" }).entries;
  }

  it("attaches variants to trailing-callback folds", () => {
    const entries = foldEntries('describe("x", () => {\n  run();\n});');
    expect(entries[0]).toMatchObject({
      type: "fold",
      headerVariants: ['describe("x")'],
    });
  });

  it("omits the key on folds without variants", () => {
    const entries = foldEntries("if (flag) {\n  run();\n}");
    const entry = entries[0];
    if (!entry) throw new Error("expected fold entry");
    expect("headerVariants" in entry).toBe(false);
  });
});
