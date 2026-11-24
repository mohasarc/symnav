import { describe, expect, it } from "vitest";
import { OverviewTree, formatSymbolIdentity, type SymbolOverviewNode } from "@symnav/core";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { extractFileEntries } from "./extract-file-entries.js";

describe("JSDoc type alias declarations in overview", () => {
  it("lists @typedef and @callback tags before a statement as type aliases spanning their tag lines", () => {
    const source = [
      "exports.q = 1;",
      "/**",
      " * @typedef {Object} Shape",
      " * @property {number} width",
      " */",
      "/**",
      " * @callback Visit",
      " * @param {Shape} shape",
      " */",
      "function walk() {}",
    ].join("\n");

    expect(summariesOf(source)).toEqual([
      { id: "input.js::q", label: "variable", range: [1, 1], header: ["exports.q = 1"] },
      {
        id: "input.js::Shape",
        label: "type-alias",
        range: [3, 4],
        header: ["@typedef {Object} Shape"],
      },
      { id: "input.js::Visit", label: "type-alias", range: [7, 8], header: ["@callback Visit"] },
      {
        id: "input.js::walk",
        label: "function-implementation",
        range: [10, 10],
        header: ["function walk()"],
      },
    ]);
  });

  it("lists each type alias tag of one comment", () => {
    const source = ["/**", " * @typedef {string} A", " * @typedef {number} B", " */", "f();"].join(
      "\n",
    );

    expect(summariesOf(source)).toEqual([
      { id: "input.js::A", label: "type-alias", range: [2, 2], header: ["@typedef {string} A"] },
      { id: "input.js::B", label: "type-alias", range: [3, 3], header: ["@typedef {number} B"] },
    ]);
  });

  it("lists type alias tags at the end of the file and in a file without statements", () => {
    expect(idsOf("export const x = 1;\n/** @typedef {string} Tail */\n")).toEqual([
      "input.js::x",
      "input.js::Tail",
    ]);
    expect(idsOf("/** @callback Only */\n")).toEqual(["input.js::Only"]);
  });

  it("nests type alias tags of statements in a function body or block under their scope", () => {
    const source = [
      "function outer() {",
      "  /** @typedef {string} Inner */",
      "  const local = 1;",
      "  if (local) {",
      "    /** @typedef {number} InBlock */",
      "    run();",
      "  }",
      "}",
      "var later = () => {",
      "  /** @callback InArrow */",
      "  return 1;",
      "};",
    ].join("\n");

    expect(idsOf(source)).toEqual([
      "input.js::outer",
      "input.js::outer::Inner",
      "input.js::outer::local",
      "input.js::outer::InBlock",
      "input.js::later",
      "input.js::later::InArrow",
    ]);
  });

  it("emits no node for nameless or dotted type alias tags", () => {
    const source = [
      "/** @typedef {string} */",
      "var Alias;",
      "/** @typedef {string} ns.Dotted */",
      "var ns = {};",
    ].join("\n");

    expect(idsOf(source)).toEqual(["input.js::Alias", "input.js::ns"]);
  });

  it("emits no node for the same syntax in a TypeScript file", () => {
    expect(idsOf("/** @typedef {string} A */\nexport const x = 1;\n", "input.ts")).toEqual([
      "input.ts::x",
    ]);
  });
});

interface DeclarationSummary {
  readonly id: string;
  readonly label: string;
  readonly range: readonly [number, number];
  readonly header: readonly string[];
}

function summariesOf(source: string): readonly DeclarationSummary[] {
  return symbolsOf(source).map((symbol) => ({
    id: idOf(symbol),
    label: symbol.kind.nativeLabel,
    range: [symbol.range.startLine, symbol.range.endLine],
    header: symbol.header.lines,
  }));
}

function idsOf(source: string, filePath: string = "input.js"): readonly string[] {
  return symbolsOf(source, filePath).map(idOf);
}

function symbolsOf(source: string, filePath: string = "input.js"): readonly SymbolOverviewNode[] {
  const sourceFile = parseTypeScriptSource(source, filePath);
  return OverviewTree.walkSymbols(extractFileEntries({ sourceFile, filePath }).entries);
}

function idOf(symbol: SymbolOverviewNode): string {
  return formatSymbolIdentity(symbol.identity);
}
