import { describe, expect, it } from "vitest";

import type {
  FoldOverviewNode,
  OverviewFileSymbols,
  OverviewNode,
  SymbolOverviewNode,
} from "../intermediate-representation/overview-tree.js";
import type { Signature } from "../intermediate-representation/types.js";
import { OverviewExpander } from "./overview-expander.js";

function symbol(
  name: string,
  partial: Partial<Pick<SymbolOverviewNode, "range" | "header" | "children">> = {},
): SymbolOverviewNode {
  const range = partial.range ?? { startLine: 1, endLine: 1 };
  return {
    type: "symbol",
    identity: { file: "src/file.ts", segments: [{ name }] },
    kind: { role: "value", nativeLabel: "function" },
    range,
    header: partial.header ?? signature(range.startLine, `function ${name}(): void`),
    children: partial.children ?? [],
  };
}

function fold(
  header: string,
  partial: Partial<Pick<FoldOverviewNode, "range" | "children">> = {},
): FoldOverviewNode {
  return {
    type: "fold",
    foldKind: "block",
    range: partial.range ?? { startLine: 1, endLine: 3 },
    header: signature(partial.range?.startLine ?? 1, header),
    children: partial.children ?? [],
  };
}

function signature(startLine: number, ...lines: string[]): Signature {
  return { startLine, lines };
}

function expand(entries: readonly OverviewNode[], depth: number): readonly OverviewNode[] {
  const file: OverviewFileSymbols = { file: "src/file.ts", entries };
  return new OverviewExpander({
    file,
    request: { depth, at: undefined, line: undefined },
  }).expand().entries;
}

describe("OverviewExpander depth", () => {
  it("renders symbol children and fold headers at depth 0", () => {
    const entries = [
      symbol("outer", {
        range: { startLine: 1, endLine: 10 },
        children: [
          symbol("nested", { range: { startLine: 2, endLine: 2 } }),
          fold("if (flag) {", {
            range: { startLine: 3, endLine: 8 },
            children: [symbol("insideFold", { range: { startLine: 4, endLine: 4 } })],
          }),
        ],
      }),
    ];

    expect(expand(entries, 0)).toEqual([
      symbol("outer", {
        range: { startLine: 1, endLine: 10 },
        children: [
          symbol("nested", { range: { startLine: 2, endLine: 2 } }),
          fold("if (flag) {", {
            range: { startLine: 3, endLine: 8 },
            children: [],
          }),
        ],
      }),
    ]);
  });

  it("opens one fold interior at depth 1", () => {
    const entries = [
      fold("describe(\"outer\", () => {", {
        range: { startLine: 1, endLine: 8 },
        children: [
          symbol("helper", { range: { startLine: 2, endLine: 2 } }),
          fold("if (flag) {", {
            range: { startLine: 3, endLine: 7 },
            children: [symbol("inner", { range: { startLine: 4, endLine: 4 } })],
          }),
        ],
      }),
    ];

    expect(expand(entries, 1)).toEqual([
      fold("describe(\"outer\", () => {", {
        range: { startLine: 1, endLine: 8 },
        children: [
          symbol("helper", { range: { startLine: 2, endLine: 2 } }),
          fold("if (flag) {", {
            range: { startLine: 3, endLine: 7 },
            children: [],
          }),
        ],
      }),
    ]);
  });

  it("opens nested fold interiors at depth 2", () => {
    const entries = [
      fold("describe(\"outer\", () => {", {
        range: { startLine: 1, endLine: 8 },
        children: [
          fold("if (flag) {", {
            range: { startLine: 2, endLine: 7 },
            children: [symbol("inner", { range: { startLine: 3, endLine: 3 } })],
          }),
        ],
      }),
    ];

    expect(expand(entries, 2)).toEqual([
      fold("describe(\"outer\", () => {", {
        range: { startLine: 1, endLine: 8 },
        children: [
          fold("if (flag) {", {
            range: { startLine: 2, endLine: 7 },
            children: [symbol("inner", { range: { startLine: 3, endLine: 3 } })],
          }),
        ],
      }),
    ]);
  });

  it("does not charge depth for symbol children", () => {
    const entries = [
      fold("describe(\"outer\", () => {", {
        range: { startLine: 1, endLine: 12 },
        children: [
          symbol("outerSymbol", {
            range: { startLine: 2, endLine: 10 },
            children: [
              symbol("innerSymbol", {
                range: { startLine: 3, endLine: 9 },
                children: [
                  fold("if (flag) {", {
                    range: { startLine: 4, endLine: 8 },
                    children: [symbol("insideFold", { range: { startLine: 5, endLine: 5 } })],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ];

    expect(expand(entries, 1)).toEqual([
      fold("describe(\"outer\", () => {", {
        range: { startLine: 1, endLine: 12 },
        children: [
          symbol("outerSymbol", {
            range: { startLine: 2, endLine: 10 },
            children: [
              symbol("innerSymbol", {
                range: { startLine: 3, endLine: 9 },
                children: [
                  fold("if (flag) {", {
                    range: { startLine: 4, endLine: 8 },
                    children: [],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ]);
  });
});
