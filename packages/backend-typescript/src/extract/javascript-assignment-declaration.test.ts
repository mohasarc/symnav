import { describe, expect, it } from "vitest";
import { OverviewTree, formatSymbolIdentity, type SymbolOverviewNode } from "@symnav/core";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { extractFileEntries } from "./extract-file-entries.js";

describe("CommonJS export declarations in overview", () => {
  it.each([
    [
      "exports.foo",
      "exports.foo = function (a) { return a; };",
      "exports.foo = function (a) { return a; }",
    ],
    ["module.exports.foo", "module.exports.foo = (a) => a;", "module.exports.foo = (a) => a"],
  ])("lists %s with a function value as a function implementation", (_form, source, header) => {
    expect(summariesOf(source)).toEqual([
      {
        id: "input.js::foo",
        label: "function-implementation",
        range: [1, 1],
        header: [header],
      },
    ]);
  });

  it("lists a non-function export property as a variable spanning its statement", () => {
    const source = ["exports.config = {", "  retries: 3,", "};"].join("\n");

    expect(summariesOf(source)).toEqual([
      {
        id: "input.js::config",
        label: "variable",
        range: [1, 3],
        header: ["exports.config = { … }"],
      },
    ]);
  });

  it("lists each export property of an assignment chain against the assigned value", () => {
    expect(summariesOf("exports.a = module.exports.b = 3;")).toEqual([
      { id: "input.js::a", label: "variable", range: [1, 1], header: ["exports.a = 3"] },
      { id: "input.js::b", label: "variable", range: [1, 1], header: ["module.exports.b = 3"] },
    ]);
  });

  it("lists export properties assigned in a comma sequence or inside parentheses", () => {
    expect(idsOf("exports.a = 1, exports.b = 2;\n(exports.c = 3);")).toEqual([
      "input.js::a",
      "input.js::b",
      "input.js::c",
    ]);
  });

  it("nests declarations from a function value's body under the export", () => {
    const source = ["exports.foo = function () {", "  function inner() {}", "};"].join("\n");

    expect(idsOf(source)).toEqual(["input.js::foo", "input.js::foo::inner"]);
  });

  it("emits no node for an export property aliasing a same-name local", () => {
    const source = ["function foo() {}", "exports.foo = foo;", "exports.bar = foo;"].join("\n");

    expect(idsOf(source)).toEqual(["input.js::foo", "input.js::bar"]);
  });

  it("emits no node for a void 0 export placeholder", () => {
    expect(summariesOf("exports.foo = exports.bar = void 0;")).toEqual([]);
  });

  it("lists export properties assigned inside a top-level block", () => {
    const source = [
      "if (typeof window === 'undefined') {",
      "  exports.server = true;",
      "}",
      "if (typeof window !== 'undefined') exports.client = true;",
    ].join("\n");

    expect(idsOf(source)).toEqual(["input.js::server", "input.js::client"]);
  });

  it("emits no symbols for the same syntax in a TypeScript file", () => {
    const source = ["exports.foo = function () {};", "module.exports.bar = 1;"].join("\n");

    expect(OverviewTree.walkSymbols(fileEntriesOf(source, "input.ts").entries)).toEqual([]);
  });
});

interface DeclarationSummary {
  readonly id: string;
  readonly label: string;
  readonly range: readonly [number, number];
  readonly header: readonly string[];
}

function summariesOf(source: string): readonly DeclarationSummary[] {
  return OverviewTree.walkSymbols(fileEntriesOf(source).entries).map((symbol) => ({
    id: idOf(symbol),
    label: symbol.kind.nativeLabel,
    range: [symbol.range.startLine, symbol.range.endLine],
    header: symbol.header.lines,
  }));
}

function idsOf(source: string): readonly string[] {
  return OverviewTree.walkSymbols(fileEntriesOf(source).entries).map(idOf);
}

function fileEntriesOf(source: string, filePath: string = "input.js") {
  return extractFileEntries({ sourceFile: parseTypeScriptSource(source, filePath), filePath });
}

function idOf(symbol: SymbolOverviewNode): string {
  return formatSymbolIdentity(symbol.identity);
}
