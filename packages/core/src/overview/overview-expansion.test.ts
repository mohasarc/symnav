import { describe, expect, it } from "vitest";

import type {
  FoldOverviewNode,
  OverviewFileEntries,
  OverviewNode,
  SymbolOverviewNode,
} from "../intermediate-representation/overview-tree.js";
import type { Header } from "../intermediate-representation/types.js";
import { OverviewExpander } from "./overview-expander.js";
import {
  AmbiguousLineTargetError,
  AmbiguousOverviewTargetError,
  type OverviewExpansionRequest,
  OverviewTargetNotFoundError,
} from "./overview-query.js";

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

function signature(startLine: number, ...lines: string[]): Header {
  return { startLine, lines };
}

function expand(entries: readonly OverviewNode[], depth: number): readonly OverviewNode[] {
  return expandRequest(entries, { depth, at: undefined, line: undefined }).entries;
}

function expandRequest(
  entries: readonly OverviewNode[],
  request: OverviewExpansionRequest,
): OverviewFileEntries {
  const file: OverviewFileEntries = { file: "src/file.ts", entries };
  return new OverviewExpander({
    file,
    request,
  }).expand();
}

function renderThrownError(thunk: () => void): string {
  try {
    thunk();
  } catch (err) {
    if (err instanceof Error && "render" in err && typeof err.render === "function") {
      return err.render();
    }
    throw err;
  }
  throw new Error("Expected thunk to throw");
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
      fold('describe("outer", () => {', {
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
      fold('describe("outer", () => {', {
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
      fold('describe("outer", () => {', {
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
      fold('describe("outer", () => {', {
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
      fold('describe("outer", () => {', {
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
      fold('describe("outer", () => {', {
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

describe("OverviewExpander target selection", () => {
  it("selects a fold by copied header substring", () => {
    const entries = [
      fold('describe("setup", () => {', {
        range: { startLine: 1, endLine: 3 },
        children: [symbol("setupHelper", { range: { startLine: 2, endLine: 2 } })],
      }),
      fold('describe("cursor", () => {', {
        range: { startLine: 5, endLine: 9 },
        children: [
          symbol("cursorHelper", { range: { startLine: 6, endLine: 6 } }),
          fold("if (enabled) {", {
            range: { startLine: 7, endLine: 8 },
            children: [symbol("inner", { range: { startLine: 8, endLine: 8 } })],
          }),
        ],
      }),
    ];

    expect(
      expandRequest(entries, { depth: 1, at: 'describe("cursor")', line: undefined }),
    ).toMatchObject({
      file: "src/file.ts",
      request: { depth: 1, at: 'describe("cursor")', line: undefined },
      entries: [
        fold('describe("cursor", () => {', {
          range: { startLine: 5, endLine: 9 },
          children: [
            symbol("cursorHelper", { range: { startLine: 6, endLine: 6 } }),
            fold("if (enabled) {", {
              range: { startLine: 7, endLine: 8 },
              children: [],
            }),
          ],
        }),
      ],
    });
  });

  it("returns candidates for a line-only match instead of picking an innermost node", () => {
    const entries = [
      symbol("outer", {
        range: { startLine: 1, endLine: 10 },
        children: [
          fold("if (flag) {", {
            range: { startLine: 3, endLine: 8 },
            children: [symbol("inside", { range: { startLine: 4, endLine: 4 } })],
          }),
        ],
      }),
    ];

    expect(() => expandRequest(entries, { depth: 0, at: undefined, line: 4 })).toThrow(
      AmbiguousLineTargetError,
    );
    expect(
      renderThrownError(() => expandRequest(entries, { depth: 0, at: undefined, line: 4 })),
    ).toContain("4: inside");
  });

  it("uses --line to narrow --at candidates", () => {
    const entries = [
      fold('describe("first", () => {', {
        range: { startLine: 1, endLine: 3 },
      }),
      fold('describe("second", () => {', {
        range: { startLine: 8, endLine: 10 },
      }),
    ];

    expect(expandRequest(entries, { depth: 0, at: "describe", line: 9 }).entries).toEqual([
      fold('describe("second", () => {', {
        range: { startLine: 8, endLine: 10 },
      }),
    ]);
  });

  it("reports not found when --at and --line narrow to zero candidates", () => {
    const entries = [
      fold('describe("cursor", () => {', {
        range: { startLine: 1, endLine: 3 },
      }),
    ];

    expect(() => expandRequest(entries, { depth: 0, at: "cursor", line: 9 })).toThrow(
      OverviewTargetNotFoundError,
    );
  });

  it("reports candidates when --at and --line still match multiple nodes", () => {
    const entries = [
      fold('describe("a", () => {', {
        range: { startLine: 1, endLine: 1 },
      }),
      fold('describe("b", () => {', {
        range: { startLine: 1, endLine: 1 },
      }),
    ];

    expect(() => expandRequest(entries, { depth: 0, at: "describe", line: 1 })).toThrow(
      AmbiguousOverviewTargetError,
    );
    expect(
      renderThrownError(() => expandRequest(entries, { depth: 0, at: "describe", line: 1 })),
    ).toContain('1: describe("b", () => {');
  });

  it("keeps same-line folds ambiguous under --line and addressable under longer --at text", () => {
    const entries = [
      fold('describe("cursor", () => {', {
        range: { startLine: 1, endLine: 1 },
      }),
      fold('describe("cursor nested", () => {', {
        range: { startLine: 1, endLine: 1 },
      }),
    ];

    expect(() => expandRequest(entries, { depth: 0, at: undefined, line: 1 })).toThrow(
      AmbiguousLineTargetError,
    );
    expect(
      expandRequest(entries, { depth: 0, at: 'describe("cursor nested")', line: 1 }).entries,
    ).toEqual([
      fold('describe("cursor nested", () => {', {
        range: { startLine: 1, endLine: 1 },
      }),
    ]);
  });
});
