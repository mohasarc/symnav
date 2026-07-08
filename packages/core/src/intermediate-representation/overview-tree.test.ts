import { describe, expect, it } from "vitest";

import type { FoldOverviewNode, SymbolOverviewNode } from "./overview-tree.js";

const HEADER = { startLine: 1, lines: ["function top(): void"] };
const RANGE = { startLine: 1, endLine: 3 };

describe("overview tree", () => {
  it("lets symbol and fold nodes share range, header, and children", () => {
    const nestedSymbol: SymbolOverviewNode = {
      type: "symbol",
      identity: { file: "src/file.ts", segments: [{ name: "nested" }] },
      kind: { role: "callable", nativeLabel: "function" },
      range: { startLine: 2, endLine: 2 },
      header: { startLine: 2, lines: ["function nested(): void"] },
      children: [],
    };
    const fold: FoldOverviewNode = {
      type: "fold",
      foldKind: "block",
      range: RANGE,
      header: HEADER,
      children: [nestedSymbol],
    };
    const symbol: SymbolOverviewNode = {
      type: "symbol",
      identity: { file: "src/file.ts", segments: [{ name: "top" }] },
      kind: { role: "callable", nativeLabel: "function" },
      range: RANGE,
      header: HEADER,
      children: [fold],
    };

    expect([symbol.range, fold.range]).toEqual([RANGE, RANGE]);
    expect([symbol.header, fold.header]).toEqual([HEADER, HEADER]);
    expect([symbol.children, fold.children]).toEqual([[fold], [nestedSymbol]]);
  });

  it("keeps identity and kind on symbol nodes only", () => {
    const fold: FoldOverviewNode = {
      type: "fold",
      foldKind: "conditional",
      range: RANGE,
      header: HEADER,
      children: [],
    };
    const symbol: SymbolOverviewNode = {
      type: "symbol",
      identity: { file: "src/file.ts", segments: [{ name: "top" }] },
      kind: { role: "callable", nativeLabel: "function" },
      range: RANGE,
      header: HEADER,
      children: [],
    };

    expect("identity" in symbol).toBe(true);
    expect("kind" in symbol).toBe(true);
    expect("identity" in fold).toBe(false);
    expect("kind" in fold).toBe(false);
  });
});
