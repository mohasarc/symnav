import { describe, expect, it } from "vitest";

import {
  walkOverviewSymbols,
  type OverviewNode,
  type SymbolOverviewNode,
} from "./overview-tree.js";

function symbol(name: string, children: readonly OverviewNode[] = []): SymbolOverviewNode {
  return {
    type: "symbol",
    identity: { file: "src/file.ts", segments: [{ name }] },
    kind: { role: "callable", nativeLabel: "function" },
    range: { startLine: 1, endLine: 1 },
    header: { startLine: 1, lines: [`function ${name}(): void`] },
    children,
  };
}

describe("walkOverviewSymbols", () => {
  it("returns all nested symbols in depth-first source order", () => {
    const first = symbol("first", [symbol("nested")]);
    const second = symbol("second");

    expect(walkOverviewSymbols([first, second])).toEqual([first, first.children[0], second]);
  });

  it("skips fold nodes while descending through their children", () => {
    const nested = symbol("nested");
    const entries: readonly OverviewNode[] = [
      {
        type: "fold",
        foldKind: "conditional",
        range: { startLine: 1, endLine: 3 },
        header: { startLine: 1, lines: ["if (enabled)"] },
        children: [nested],
      },
    ];

    expect(walkOverviewSymbols(entries)).toEqual([nested]);
  });
});
