import { describe, expect, it } from "vitest";

import type {
  OverviewFileEntries,
  OverviewNode,
} from "../intermediate-representation/overview-tree.js";
import { OverviewTree } from "../intermediate-representation/overview-tree.js";
import { OverviewExpander } from "./overview-expander.js";
import {
  AmbiguousLineTargetError,
  AmbiguousOverviewError,
  AmbiguousOverviewTargetError,
  InvalidOverviewExpansionRequestError,
  OverviewTargetNotFoundError,
} from "./errors.js";
import type {
  OverviewExpansionRequest,
  OverviewExpansionResult,
} from "./overview-expansion-result.js";
import { fold, symbol } from "./overview-node-builders.js";

function expandRequest(
  entries: readonly OverviewNode[],
  request: OverviewExpansionRequest,
): OverviewExpansionResult {
  const file: OverviewFileEntries = { file: "src/file.ts", entries };
  return new OverviewExpander({
    file,
    request,
  }).expand();
}

function construct(request: OverviewExpansionRequest): OverviewExpander {
  return new OverviewExpander({ file: { file: "src/file.ts", entries: [] }, request });
}

function thrownValidationReason(request: OverviewExpansionRequest): string {
  try {
    construct(request);
  } catch (err) {
    if (err instanceof InvalidOverviewExpansionRequestError) return err.reason;
    throw err;
  }
  throw new Error("Expected construction to throw InvalidOverviewExpansionRequestError");
}

function thrownCandidateHeaders(thunk: () => void): readonly string[] {
  try {
    thunk();
  } catch (err) {
    if (err instanceof AmbiguousOverviewError) {
      return err.candidates.map((candidate) => candidate.header);
    }
    throw err;
  }
  throw new Error("Expected thunk to throw an ambiguous overview error");
}

describe("OverviewExpander request validation", () => {
  it.each([-1, 1.5, Number.NaN])("rejects depth %s at construction", (depth) => {
    expect(thrownValidationReason({ depth, at: undefined, line: undefined })).toBe(
      `invalid overview request: depth must be a non-negative integer, got ${depth}`,
    );
  });

  it.each([0, -3, 2.5])("rejects line %s at construction", (line) => {
    expect(thrownValidationReason({ depth: 0, at: undefined, line })).toBe(
      `invalid overview request: line must be a positive integer, got ${line}`,
    );
  });

  it("constructs at depth 0 without a line", () => {
    expect(() => construct({ depth: 0, at: undefined, line: undefined })).not.toThrow();
  });

  it("constructs with positive integer depth and line", () => {
    expect(() => construct({ depth: 2, at: undefined, line: 5 })).not.toThrow();
  });
});

describe("OverviewExpander depth", () => {
  it("renders only top-level nodes at depth 0", () => {
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

    expect(expandRequest(entries, { depth: 0, at: undefined, line: undefined }).entries).toEqual([
      symbol("outer", {
        range: { startLine: 1, endLine: 10 },
        children: [],
      }),
    ]);
  });

  it("renders one child level at depth 1", () => {
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

    expect(expandRequest(entries, { depth: 1, at: undefined, line: undefined }).entries).toEqual([
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

  it("renders two child levels at depth 2", () => {
    const entries = [
      fold('describe("outer", () => {', {
        range: { startLine: 1, endLine: 10 },
        children: [
          symbol("helper", { range: { startLine: 2, endLine: 2 } }),
          fold("if (flag) {", {
            range: { startLine: 3, endLine: 9 },
            children: [symbol("inner", { range: { startLine: 4, endLine: 4 } })],
          }),
        ],
      }),
    ];

    expect(expandRequest(entries, { depth: 2, at: undefined, line: undefined }).entries).toEqual([
      fold('describe("outer", () => {', {
        range: { startLine: 1, endLine: 10 },
        children: [
          symbol("helper", { range: { startLine: 2, endLine: 2 } }),
          fold("if (flag) {", {
            range: { startLine: 3, endLine: 9 },
            children: [symbol("inner", { range: { startLine: 4, endLine: 4 } })],
          }),
        ],
      }),
    ]);
  });

  it("renders symbol child levels uniformly at depth 2", () => {
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

    expect(expandRequest(entries, { depth: 2, at: undefined, line: undefined }).entries).toEqual([
      fold('describe("outer", () => {', {
        range: { startLine: 1, endLine: 12 },
        children: [
          symbol("outerSymbol", {
            range: { startLine: 2, endLine: 10 },
            children: [
              symbol("innerSymbol", {
                range: { startLine: 3, endLine: 9 },
                children: [],
              }),
            ],
          }),
        ],
      }),
    ]);
  });

  it("reaches a fold nested under two symbols at depth 3", () => {
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

    expect(expandRequest(entries, { depth: 3, at: undefined, line: undefined }).entries).toEqual([
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

describe("OverviewExpander totalSymbolCount", () => {
  it("counts the full pre-expansion tree when depth pruning hides fold interiors", () => {
    const entries = [
      symbol("top", { range: { startLine: 1, endLine: 1 } }),
      fold("if (flag) {", {
        range: { startLine: 3, endLine: 8 },
        children: [
          symbol("insideFold", { range: { startLine: 4, endLine: 4 } }),
          symbol("alsoInside", { range: { startLine: 5, endLine: 5 } }),
        ],
      }),
    ];

    const result = new OverviewExpander({
      file: { file: "src/file.ts", entries },
      request: { depth: 0, at: undefined, line: undefined },
    }).expand();

    expect(result.totalSymbolCount).toBe(3);
    expect(OverviewTree.walkSymbols(result.entries)).toHaveLength(1);
  });

  it("counts the full tree when targeted selection narrows entries to one subtree", () => {
    const entries = [
      symbol("alpha", { range: { startLine: 1, endLine: 2 } }),
      symbol("beta", { range: { startLine: 4, endLine: 5 } }),
    ];

    const result = new OverviewExpander({
      file: { file: "src/file.ts", entries },
      request: { depth: 0, at: "alpha", line: undefined },
    }).expand();

    expect(result.totalSymbolCount).toBe(2);
    expect(OverviewTree.walkSymbols(result.entries)).toHaveLength(1);
  });
});

describe("OverviewExpander target selection", () => {
  it("prefers a unique exact displayed symbol label over containing member labels", () => {
    const entries = [
      symbol("Greeter", {
        range: { startLine: 1, endLine: 9 },
        children: [
          symbol("greet", {
            range: { startLine: 2, endLine: 4 },
            identity: {
              file: "src/file.ts",
              segments: [{ name: "Greeter" }, { name: "greet" }],
            },
          }),
          symbol("shout", {
            range: { startLine: 6, endLine: 8 },
            identity: {
              file: "src/file.ts",
              segments: [{ name: "Greeter" }, { name: "shout" }],
            },
          }),
        ],
      }),
    ];

    expect(expandRequest(entries, { depth: 1, at: "Greeter", line: undefined }).entries).toEqual(
      entries,
    );
  });

  it("keeps several exact displayed labels ambiguous", () => {
    const entries = [
      fold("shared label", { range: { startLine: 1, endLine: 2 } }),
      fold("shared label", { range: { startLine: 4, endLine: 5 } }),
    ];

    expect(() => expandRequest(entries, { depth: 0, at: "shared label", line: undefined })).toThrow(
      AmbiguousOverviewTargetError,
    );
  });

  it("preserves substring ambiguity and candidate ordering without an exact displayed label", () => {
    const entries = [
      symbol("FirstGreeter", { range: { startLine: 1, endLine: 2 } }),
      symbol("SecondGreeter", { range: { startLine: 4, endLine: 5 } }),
    ];

    expect(
      thrownCandidateHeaders(() =>
        expandRequest(entries, { depth: 0, at: "Greeter", line: undefined }),
      ),
    ).toEqual(["1-2: FirstGreeter", "4-5: SecondGreeter"]);
  });

  it("applies line narrowing before exact displayed-label preference", () => {
    const entries = [
      symbol("Greeter", { range: { startLine: 1, endLine: 2 } }),
      symbol("NestedGreeter", { range: { startLine: 4, endLine: 5 } }),
    ];

    expect(expandRequest(entries, { depth: 0, at: "Greeter", line: 4 }).entries).toEqual([
      symbol("NestedGreeter", { range: { startLine: 4, endLine: 5 } }),
    ]);
  });

  it("keeps copied full headers searchable without treating them as exact displayed labels", () => {
    const entries = [
      fold("alpha", { range: { startLine: 1, endLine: 2 } }),
      fold("wrapper 1-2: alpha", { range: { startLine: 4, endLine: 5 } }),
    ];

    expect(() => expandRequest(entries, { depth: 0, at: "1-2: alpha", line: undefined })).toThrow(
      AmbiguousOverviewTargetError,
    );
  });

  it("keeps fold header variants searchable without treating them as exact displayed labels", () => {
    const entries = [
      fold('describe("beta", async () => {', {
        range: { startLine: 1, endLine: 3 },
        headerVariants: ['describe("beta")'],
      }),
      fold('wrapper 1-3: describe("beta")', {
        range: { startLine: 5, endLine: 7 },
      }),
    ];

    expect(() =>
      expandRequest(entries, { depth: 0, at: '1-3: describe("beta")', line: undefined }),
    ).toThrow(AmbiguousOverviewTargetError);
  });

  it("selects a fold by copied header substring", () => {
    const entries = [
      fold('describe("setup", () => {', {
        range: { startLine: 1, endLine: 3 },
        children: [symbol("setupHelper", { range: { startLine: 2, endLine: 2 } })],
      }),
      fold('describe("cursor", () => {', {
        range: { startLine: 5, endLine: 9 },
        headerVariants: ['describe("cursor")'],
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
          headerVariants: ['describe("cursor")'],
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

  it("matches a fold against its backend-provided header variants", () => {
    const entries = [
      fold('describe("beta", async () => {', {
        range: { startLine: 1, endLine: 3 },
        headerVariants: ['describe("beta")'],
        children: [symbol("betaHelper", { range: { startLine: 2, endLine: 2 } })],
      }),
    ];

    expect(
      expandRequest(entries, { depth: 1, at: 'describe("beta")', line: undefined }).entries,
    ).toEqual([
      fold('describe("beta", async () => {', {
        range: { startLine: 1, endLine: 3 },
        headerVariants: ['describe("beta")'],
        children: [symbol("betaHelper", { range: { startLine: 2, endLine: 2 } })],
      }),
    ]);
  });

  it("matches a copied full line built from a header variant", () => {
    const entries = [
      fold('describe("beta", async () => {', {
        range: { startLine: 1, endLine: 3 },
        headerVariants: ['describe("beta")'],
      }),
    ];

    expect(
      expandRequest(entries, { depth: 0, at: '1-3: describe("beta")', line: undefined }).entries,
    ).toEqual([
      fold('describe("beta", async () => {', {
        range: { startLine: 1, endLine: 3 },
        headerVariants: ['describe("beta")'],
      }),
    ]);
  });

  it("requires the open form when a fold carries no variants", () => {
    const entries = [
      fold('describe("beta", () => {', {
        range: { startLine: 1, endLine: 3 },
      }),
    ];

    expect(() =>
      expandRequest(entries, { depth: 0, at: 'describe("beta")', line: undefined }),
    ).toThrow(OverviewTargetNotFoundError);
  });

  it("matches symbol nodes by their identity header", () => {
    const entries = [
      symbol("alpha", { range: { startLine: 1, endLine: 2 } }),
      symbol("beta", { range: { startLine: 4, endLine: 5 } }),
    ];

    expect(expandRequest(entries, { depth: 0, at: "alpha", line: undefined }).entries).toEqual([
      symbol("alpha", { range: { startLine: 1, endLine: 2 } }),
    ]);
  });

  it("selects nested targets from the full tree before trimming depth", () => {
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

    expect(expandRequest(entries, { depth: 0, at: "inside", line: undefined }).entries).toEqual([
      symbol("inside", { range: { startLine: 4, endLine: 4 } }),
    ]);
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
      thrownCandidateHeaders(() => expandRequest(entries, { depth: 0, at: undefined, line: 4 })),
    ).toContain("4: inside");
  });

  it("uses a line target to narrow header-text candidates", () => {
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

  it("reports not found when header text and line narrow to zero candidates", () => {
    const entries = [
      fold('describe("cursor", () => {', {
        range: { startLine: 1, endLine: 3 },
      }),
    ];

    expect(() => expandRequest(entries, { depth: 0, at: "cursor", line: 9 })).toThrow(
      OverviewTargetNotFoundError,
    );
  });

  it("reports candidates when header text and line still match multiple nodes", () => {
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
      thrownCandidateHeaders(() => expandRequest(entries, { depth: 0, at: "describe", line: 1 })),
    ).toContain('1: describe("b", () => {');
  });

  it("keeps same-line folds ambiguous under a line target and addressable under longer header text", () => {
    const entries = [
      fold('describe("cursor", () => {', {
        range: { startLine: 1, endLine: 1 },
        headerVariants: ['describe("cursor")'],
      }),
      fold('describe("cursor nested", () => {', {
        range: { startLine: 1, endLine: 1 },
        headerVariants: ['describe("cursor nested")'],
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
        headerVariants: ['describe("cursor nested")'],
      }),
    ]);
  });
});

describe("OverviewExpander identity stability across expansion", () => {
  const entries = [
    fold('describe("alpha", () => {', {
      range: { startLine: 1, endLine: 6 },
      children: [
        symbol("dup", {
          range: { startLine: 2, endLine: 5 },
          identity: { file: "src/file.ts", segments: [{ name: "dup", disambiguator: 1 }] },
          children: [
            fold("if (flag) {", {
              range: { startLine: 3, endLine: 4 },
              children: [symbol("hidden", { range: { startLine: 4, endLine: 4 } })],
            }),
          ],
        }),
      ],
    }),
    fold('describe("beta", () => {', {
      range: { startLine: 8, endLine: 11 },
      children: [
        symbol("dup", {
          range: { startLine: 9, endLine: 10 },
          identity: { file: "src/file.ts", segments: [{ name: "dup", disambiguator: 2 }] },
        }),
      ],
    }),
  ];

  it("preserves identity segments through depth pruning", () => {
    const result = expandRequest(entries, { depth: 1, at: undefined, line: undefined });
    const survivors = OverviewTree.walkSymbols(result.entries);

    expect(survivors.map((survivor) => survivor.identity.segments)).toEqual([
      [{ name: "dup", disambiguator: 1 }],
      [{ name: "dup", disambiguator: 2 }],
    ]);
  });

  it("shows a targeted fold's symbol under its file-global disambiguator", () => {
    const result = expandRequest(entries, { depth: 1, at: 'describe("beta"', line: undefined });
    const shown = OverviewTree.walkSymbols(result.entries);

    expect(shown).toHaveLength(1);
    expect(shown[0]!.identity.segments).toEqual([{ name: "dup", disambiguator: 2 }]);
  });

  it("preserves identity segments under line and at subtree selection", () => {
    const byLine = expandRequest(entries, { depth: 1, at: undefined, line: 11 });
    expect(
      OverviewTree.walkSymbols(byLine.entries).map((shown) => shown.identity.segments),
    ).toEqual([[{ name: "dup", disambiguator: 2 }]]);

    const byAt = expandRequest(entries, { depth: 0, at: "dup#2", line: undefined });
    expect(OverviewTree.walkSymbols(byAt.entries).map((shown) => shown.identity.segments)).toEqual([
      [{ name: "dup", disambiguator: 2 }],
    ]);
  });
});
