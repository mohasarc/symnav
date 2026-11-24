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

  it("lists export properties named by a string, template or numeric element access", () => {
    const source = [
      'exports["x"] = 1;',
      'module["exports"].y = 2;',
      'module.exports["z"] = 3;',
      "exports[`t`] = 4;",
      "exports[0x10] = 5;",
    ].join("\n");

    expect(summariesOf(source).map((summary) => [summary.id, summary.header])).toEqual([
      ["input.js::x", ['exports["x"] = 1']],
      ["input.js::y", ['module["exports"].y = 2']],
      ["input.js::z", ['module.exports["z"] = 3']],
      ["input.js::t", ["exports[`t`] = 4"]],
      ["input.js::16", ["exports[0x10] = 5"]],
    ]);
  });

  it("emits no node for an export name a canonical id cannot spell or a computed key", () => {
    expect(idsOf('exports["a::b"] = 1;\nexports["x#2"] = 2;\nexports[key] = 3;')).toEqual([]);
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

  it("lists an export assigned in a variable initializer at module level after the variable", () => {
    expect(summariesOf("var app = module.exports.app = function () {};")).toEqual([
      {
        id: "input.js::app#1",
        label: "variable",
        range: [1, 1],
        header: ["var app = module.exports.app = function () {}"],
      },
      {
        id: "input.js::app#2",
        label: "function-implementation",
        range: [1, 1],
        header: ["module.exports.app = function () {}"],
      },
    ]);
  });

  it("lists exports assigned inside function bodies at module level after their statement", () => {
    const source = [
      "function init() {",
      "  exports.inner = 1;",
      "}",
      "function wrap(exports) {",
      "  exports.shadowed = 2;",
      "}",
      "(function () {",
      "  exports.iife = 3;",
      "})();",
      "const later = () => (exports.late = 4);",
    ].join("\n");

    const topLevel = OverviewTree.directSymbolChildren(fileEntriesOf(source).entries);

    expect(topLevel.map(idOf)).toEqual([
      "input.js::init",
      "input.js::inner",
      "input.js::wrap",
      "input.js::shadowed",
      "input.js::iife",
      "input.js::later",
      "input.js::late",
    ]);
    expect(idsOf(source)).toHaveLength(topLevel.length);
  });

  it("lists the members of a module.exports object literal", () => {
    const source = [
      "function a() {}",
      "module.exports = {",
      "  a,",
      "  b(x) {",
      "    return x;",
      "  },",
      "  c: 1,",
      "  d: function () {},",
      "};",
    ].join("\n");

    expect(summariesOf(source)).toEqual([
      {
        id: "input.js::a",
        label: "function-implementation",
        range: [1, 1],
        header: ["function a()"],
      },
      { id: "input.js::b", label: "function-implementation", range: [4, 6], header: ["b(x)"] },
      { id: "input.js::c", label: "variable", range: [7, 7], header: ["c: 1"] },
      {
        id: "input.js::d",
        label: "function-implementation",
        range: [8, 8],
        header: ["d: function () {}"],
      },
    ]);
  });

  it("lists module.exports object accessors and literal-named members", () => {
    const source = [
      "module.exports = {",
      "  get size() { return 1; },",
      "  set size(value) {},",
      '  ["computed"]: 1,',
      "  7: 2,",
      "  0x10: 3,",
      '  "dash-key": 4,',
      "  [`template`]: 5,",
      "  [dynamic]: 6,",
      "  ...rest,",
      "};",
    ].join("\n");

    expect(
      summariesOf(source).map((summary) => [summary.id, summary.label, summary.header]),
    ).toEqual([
      ["input.js::size#1", "getter", ["get size()"]],
      ["input.js::size#2", "setter", ["set size(value)"]],
      ["input.js::computed", "variable", ['["computed"]: 1']],
      ["input.js::7", "variable", ["7: 2"]],
      ["input.js::16", "variable", ["0x10: 3"]],
      ["input.js::dash-key", "variable", ['"dash-key": 4']],
      ["input.js::template", "variable", ["[`template`]: 5"]],
    ]);
  });

  it("lists the members of a parenthesized or chained module.exports object literal", () => {
    expect(idsOf("module.exports = ({ a: 1 });\nmodule.exports = exports = { b: 2 };")).toEqual([
      "input.js::a",
      "input.js::b",
    ]);
  });

  it("nests declarations from a module.exports method body under the member", () => {
    const source = ["module.exports = {", "  b() {", "    function inner() {}", "  },", "};"].join(
      "\n",
    );

    expect(idsOf(source)).toEqual(["input.js::b", "input.js::b::inner"]);
  });

  it("lists module.exports assigned a function as the default export", () => {
    const source = ["module.exports = function named(a) {", "  function inner() {}", "};"].join(
      "\n",
    );

    expect(summariesOf(source)[0]).toEqual({
      id: "input.js::default",
      label: "default-export",
      range: [1, 3],
      header: ["module.exports = function named(a) …"],
    });
    expect(idsOf(source)).toEqual(["input.js::default", "input.js::default::inner"]);
  });

  it("lists module.exports assigned a local as the default export", () => {
    const source = ["function Foo() {}", 'module["exports"] = Foo;'].join("\n");

    expect(summariesOf(source)).toEqual([
      {
        id: "input.js::Foo",
        label: "function-implementation",
        range: [1, 1],
        header: ["function Foo()"],
      },
      {
        id: "input.js::default",
        label: "default-export",
        range: [2, 2],
        header: ['module["exports"] = Foo'],
      },
    ]);
  });

  it("emits no default export for module.exports assigned exports itself", () => {
    expect(idsOf("module.exports = exports;\nmodule.exports = module.exports;")).toEqual([]);
  });

  it("emits no node for CommonJS export syntax in a file with ES module syntax", () => {
    const source = [
      'import helper from "./helper";',
      "exports.foo = 1;",
      'exports["bar"] = 2;',
      "function init() {",
      "  module.exports.inner = 3;",
      "}",
      "export const real = helper;",
    ].join("\n");

    expect(idsOf(source)).toEqual(["input.js::init", "input.js::real"]);
  });

  it("emits no symbols for the same syntax in a TypeScript file", () => {
    const source = [
      "exports.foo = function () {};",
      "module.exports.bar = 1;",
      "module.exports = { baz: 1 };",
      "module.exports = qux;",
    ].join("\n");

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
