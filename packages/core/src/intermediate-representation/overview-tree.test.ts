import { describe, expect, it } from "vitest";

import { OverviewTree, type OverviewNode, type SymbolOverviewNode } from "./overview-tree.js";

function symbol(name: string, children: readonly OverviewNode[] = []): SymbolOverviewNode {
  return OverviewTree.symbol({
    identity: { file: "src/file.ts", segments: [{ name }] },
    kind: { role: "callable", nativeLabel: "function" },
    range: { startLine: 1, endLine: 1 },
    header: { startLine: 1, lines: [`function ${name}(): void`] },
    children,
  });
}

function fold(children: readonly OverviewNode[]): OverviewNode {
  return OverviewTree.fold({
    foldKind: "conditional",
    range: { startLine: 1, endLine: 3 },
    header: { startLine: 1, lines: ["if (enabled)"] },
    children,
  });
}

function reExport(): OverviewNode {
  return OverviewTree.reExport({
    exportKind: "named",
    exportedNames: ["m"],
    sourceModule: "./other.js",
    range: { startLine: 1, endLine: 1 },
    header: { startLine: 1, lines: ["export { m } from './other.js'"] },
  });
}

describe("OverviewTree.walkSymbols", () => {
  it("returns all nested symbols in depth-first source order", () => {
    const first = symbol("first", [symbol("nested")]);
    const second = symbol("second");

    expect(OverviewTree.walkSymbols([first, second])).toEqual([first, first.children[0], second]);
  });

  it("skips fold nodes while descending through their children", () => {
    const nested = symbol("nested");

    expect(OverviewTree.walkSymbols([fold([nested])])).toEqual([nested]);
  });

  it("skips re-export nodes", () => {
    const sibling = symbol("sibling");

    expect(OverviewTree.walkSymbols([reExport(), sibling])).toEqual([sibling]);
  });
});

describe("OverviewTree.directSymbolChildren", () => {
  it("keeps direct symbols and drops fold and re-export siblings without descending", () => {
    const nested = symbol("nested");
    const direct = symbol("direct");

    expect(OverviewTree.directSymbolChildren([direct, fold([nested]), reExport()])).toEqual([
      direct,
    ]);
  });
});

describe("OverviewTree.scopeSymbols", () => {
  it("flattens symbols behind folds into the containing scope, stopping at symbols", () => {
    const inner = symbol("inner");
    const behindFold = symbol("behindFold", [symbol("notInScope")]);

    expect(OverviewTree.scopeSymbols([inner, fold([behindFold]), reExport()])).toEqual([
      inner,
      behindFold,
    ]);
  });
});

describe("OverviewTree.ownName", () => {
  it("returns the leaf segment name", () => {
    const method = OverviewTree.symbol({
      identity: { file: "src/file.ts", segments: [{ name: "Cls" }, { name: "m" }] },
      kind: { role: "callable", nativeLabel: "method" },
      range: { startLine: 1, endLine: 1 },
      header: { startLine: 1, lines: ["m(): void"] },
    });

    expect(OverviewTree.ownName(method)).toBe("m");
  });
});
