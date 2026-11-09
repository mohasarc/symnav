import { describe, expect, it } from "vitest";

import type {
  OverviewFileEntries,
  OverviewNode,
} from "../intermediate-representation/overview-tree.js";
import { OverviewTree } from "../intermediate-representation/overview-tree.js";
import { OverviewExpander, type OverviewExpansionRequestInput } from "./overview-expander.js";
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

function construct(request: OverviewExpansionRequestInput): OverviewExpander {
  return new OverviewExpander({ file: { file: "src/file.ts", entries: [] }, request });
}

function thrownValidationReason(request: OverviewExpansionRequestInput): string {
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
    expect(thrownValidationReason({ depth, at: undefined, line: undefined, all: false })).toBe(
      `--depth must be a non-negative integer, got ${depth}`,
    );
  });

  it.each([0, -3, 2.5])("rejects line %s at construction", (line) => {
    expect(thrownValidationReason({ depth: 0, at: undefined, line, all: false })).toBe(
      `--line must be a positive integer, got ${line}`,
    );
  });

  it.each([
    [
      { depth: "abc", at: undefined, line: undefined, all: false },
      "--depth must be a non-negative integer, got abc",
    ],
    [
      { depth: 0, at: undefined, line: "abc", all: false },
      "--line must be a positive integer, got abc",
    ],
  ])("echoes the raw option text of %o", (request, detail) => {
    expect(thrownValidationReason(request)).toBe(detail);
  });

  it("expands integer option text as numbers", () => {
    expect(
      construct({ depth: "2", at: undefined, line: undefined, all: false }).expand().request,
    ).toEqual({
      depth: 2,
      at: undefined,
      line: undefined,
      all: false,
    });
  });

  it("carries all into the request", () => {
    expect(
      construct({ depth: 0, at: undefined, line: undefined, all: true }).expand().request.all,
    ).toBe(true);
  });

  it("constructs at depth 0 without a line", () => {
    expect(() => construct({ depth: 0, at: undefined, line: undefined, all: false })).not.toThrow();
  });

  it("constructs with positive integer depth and line", () => {
    expect(() => construct({ depth: 2, at: undefined, line: 5, all: false })).not.toThrow();
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

    expect(
      expandRequest(entries, { depth: 0, at: undefined, line: undefined, all: false }).entries,
    ).toEqual([
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

    expect(
      expandRequest(entries, { depth: 1, at: undefined, line: undefined, all: false }).entries,
    ).toEqual([
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

    expect(
      expandRequest(entries, { depth: 2, at: undefined, line: undefined, all: false }).entries,
    ).toEqual([
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

    expect(
      expandRequest(entries, { depth: 2, at: undefined, line: undefined, all: false }).entries,
    ).toEqual([
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

    expect(
      expandRequest(entries, { depth: 3, at: undefined, line: undefined, all: false }).entries,
    ).toEqual([
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
      request: { depth: 0, at: undefined, line: undefined, all: false },
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
      request: { depth: 0, at: "alpha", line: undefined, all: false },
    }).expand();

    expect(result.totalSymbolCount).toBe(2);
    expect(OverviewTree.walkSymbols(result.entries)).toHaveLength(1);
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
      expandRequest(entries, { depth: 1, at: 'describe("cursor")', line: undefined, all: false }),
    ).toMatchObject({
      file: "src/file.ts",
      request: { depth: 1, at: 'describe("cursor")', line: undefined, all: false },
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
      expandRequest(entries, { depth: 1, at: 'describe("beta")', line: undefined, all: false })
        .entries,
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
      expandRequest(entries, { depth: 0, at: '1-3: describe("beta")', line: undefined, all: false })
        .entries,
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
      expandRequest(entries, { depth: 0, at: 'describe("beta")', line: undefined, all: false }),
    ).toThrow(OverviewTargetNotFoundError);
  });

  it("matches symbol nodes by their identity header", () => {
    const entries = [
      symbol("alpha", { range: { startLine: 1, endLine: 2 } }),
      symbol("beta", { range: { startLine: 4, endLine: 5 } }),
    ];

    expect(
      expandRequest(entries, { depth: 0, at: "alpha", line: undefined, all: false }).entries,
    ).toEqual([symbol("alpha", { range: { startLine: 1, endLine: 2 } })]);
  });

  it("prefers an exact symbol label over longer symbol labels", () => {
    const greeter = symbol("Greeter", {
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
    });

    expect(
      expandRequest([greeter], { depth: 1, at: "Greeter", line: undefined, all: false }).entries,
    ).toEqual([greeter]);
  });

  it("prefers an exact fold primary label over longer primary labels", () => {
    const exact = fold("cursor", { range: { startLine: 1, endLine: 2 } });
    const longer = fold("cursor details", { range: { startLine: 4, endLine: 5 } });

    expect(
      expandRequest([exact, longer], { depth: 0, at: "cursor", line: undefined, all: false })
        .entries,
    ).toEqual([exact]);
  });

  it("prefers an exact fold header variant over longer variants", () => {
    const exact = fold("cursor callback", {
      range: { startLine: 1, endLine: 2 },
      headerVariants: ["cursor"],
    });
    const longer = fold("cursor details callback", {
      range: { startLine: 4, endLine: 5 },
      headerVariants: ["cursor details"],
    });

    expect(
      expandRequest([exact, longer], { depth: 0, at: "cursor", line: undefined, all: false })
        .entries,
    ).toEqual([exact]);
  });

  describe("symbol last segment name", () => {
    const containerFile = "src/file.ts";
    const initializedValues = symbol("initializedValues", {
      range: { startLine: 2, endLine: 2 },
      identity: {
        file: containerFile,
        segments: [{ name: "createContainer" }, { name: "initializedValues" }],
      },
    });
    const initialize = symbol("initialize", {
      range: { startLine: 3, endLine: 3 },
      identity: {
        file: containerFile,
        segments: [{ name: "createContainer" }, { name: "initialize" }],
      },
      children: [fold("initializedValues.clear();", { range: { startLine: 3, endLine: 3 } })],
    });
    const createContainer = symbol("createContainer", {
      range: { startLine: 1, endLine: 5 },
      children: [initializedValues, initialize],
    });

    it("selects the symbol whose last segment equals the name over substring candidates", () => {
      expect(
        expandRequest([createContainer], {
          depth: 1,
          at: "initialize",
          line: undefined,
          all: false,
        }).entries,
      ).toEqual([initialize]);
    });

    it("selects the symbol by last segment name under line narrowing", () => {
      expect(
        expandRequest([createContainer], { depth: 0, at: "initialize", line: 3, all: false })
          .entries,
      ).toEqual([{ ...initialize, children: [] }]);
    });

    it("keeps disambiguated symbols with the same name ambiguous", () => {
      const first = symbol("object", {
        range: { startLine: 1, endLine: 2 },
        identity: { file: containerFile, segments: [{ name: "object", disambiguator: 1 }] },
      });
      const second = symbol("object", {
        range: { startLine: 4, endLine: 5 },
        identity: { file: containerFile, segments: [{ name: "object", disambiguator: 2 }] },
      });
      const statement = fold('typeof state === "object"', { range: { startLine: 7, endLine: 8 } });

      expect(
        thrownCandidateHeaders(() =>
          expandRequest([first, second, statement], {
            depth: 0,
            at: "object",
            line: undefined,
            all: false,
          }),
        ),
      ).toEqual(["1-2: object#1", "4-5: object#2"]);
    });

    it("prefers a full label match over a last segment match", () => {
      const topLevel = symbol("object", { range: { startLine: 1, endLine: 2 } });
      const nested = symbol("object", {
        range: { startLine: 5, endLine: 6 },
        identity: { file: containerFile, segments: [{ name: "outer" }, { name: "object" }] },
      });
      const outer = symbol("outer", { range: { startLine: 4, endLine: 7 }, children: [nested] });

      expect(
        expandRequest([topLevel, outer], { depth: 0, at: "object", line: undefined, all: false })
          .entries,
      ).toEqual([topLevel]);
    });
  });

  it("keeps multiple exact labels ambiguous", () => {
    const entries = [
      fold("cursor", { range: { startLine: 1, endLine: 2 } }),
      fold("cursor", { range: { startLine: 4, endLine: 5 } }),
    ];

    expect(() =>
      expandRequest(entries, { depth: 0, at: "cursor", line: undefined, all: false }),
    ).toThrow(AmbiguousOverviewTargetError);
  });

  it("preserves substring ambiguity when no label matches exactly", () => {
    const entries = [
      fold("cursor one", { range: { startLine: 1, endLine: 2 } }),
      fold("cursor two", { range: { startLine: 4, endLine: 5 } }),
    ];

    expect(() =>
      expandRequest(entries, { depth: 0, at: "cursor", line: undefined, all: false }),
    ).toThrow(AmbiguousOverviewTargetError);
  });

  it("applies line narrowing before exact label preference", () => {
    const exactOutsideLine = fold("cursor", { range: { startLine: 1, endLine: 2 } });
    const substringAtLine = fold("cursor details", { range: { startLine: 4, endLine: 5 } });

    expect(
      expandRequest([exactOutsideLine, substringAtLine], {
        depth: 0,
        at: "cursor",
        line: 5,
        all: false,
      }).entries,
    ).toEqual([substringAtLine]);
  });

  it("keeps copied full primary headers selectable by substring", () => {
    const target = fold("cursor", { range: { startLine: 1, endLine: 3 } });

    expect(
      expandRequest([target], { depth: 0, at: "1-3: cursor", line: undefined, all: false }).entries,
    ).toEqual([target]);
  });

  it("does not rank formatted range headers as exact labels", () => {
    const formattedHeader = fold("cursor", { range: { startLine: 1, endLine: 3 } });
    const substringHeader = fold("wrapper 1-3: cursor suffix", {
      range: { startLine: 5, endLine: 7 },
    });

    expect(() =>
      expandRequest([formattedHeader, substringHeader], {
        depth: 0,
        at: "1-3: cursor",
        line: undefined,
        all: false,
      }),
    ).toThrow(AmbiguousOverviewTargetError);
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

    expect(
      expandRequest(entries, { depth: 0, at: "inside", line: undefined, all: false }).entries,
    ).toEqual([symbol("inside", { range: { startLine: 4, endLine: 4 } })]);
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

    expect(() => expandRequest(entries, { depth: 0, at: undefined, line: 4, all: false })).toThrow(
      AmbiguousLineTargetError,
    );
    expect(
      thrownCandidateHeaders(() =>
        expandRequest(entries, { depth: 0, at: undefined, line: 4, all: false }),
      ),
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

    expect(
      expandRequest(entries, { depth: 0, at: "describe", line: 9, all: false }).entries,
    ).toEqual([
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

    expect(() => expandRequest(entries, { depth: 0, at: "cursor", line: 9, all: false })).toThrow(
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

    expect(() => expandRequest(entries, { depth: 0, at: "describe", line: 1, all: false })).toThrow(
      AmbiguousOverviewTargetError,
    );
    expect(
      thrownCandidateHeaders(() =>
        expandRequest(entries, { depth: 0, at: "describe", line: 1, all: false }),
      ),
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

    expect(() => expandRequest(entries, { depth: 0, at: undefined, line: 1, all: false })).toThrow(
      AmbiguousLineTargetError,
    );
    expect(
      expandRequest(entries, { depth: 0, at: 'describe("cursor nested")', line: 1, all: false })
        .entries,
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
    const result = expandRequest(entries, { depth: 1, at: undefined, line: undefined, all: false });
    const survivors = OverviewTree.walkSymbols(result.entries);

    expect(survivors.map((survivor) => survivor.identity.segments)).toEqual([
      [{ name: "dup", disambiguator: 1 }],
      [{ name: "dup", disambiguator: 2 }],
    ]);
  });

  it("shows a targeted fold's symbol under its file-global disambiguator", () => {
    const result = expandRequest(entries, {
      depth: 1,
      at: 'describe("beta"',
      line: undefined,
      all: false,
    });
    const shown = OverviewTree.walkSymbols(result.entries);

    expect(shown).toHaveLength(1);
    expect(shown[0]!.identity.segments).toEqual([{ name: "dup", disambiguator: 2 }]);
  });

  it("preserves identity segments under line and at subtree selection", () => {
    const byLine = expandRequest(entries, { depth: 1, at: undefined, line: 11, all: false });
    expect(
      OverviewTree.walkSymbols(byLine.entries).map((shown) => shown.identity.segments),
    ).toEqual([[{ name: "dup", disambiguator: 2 }]]);

    const byAt = expandRequest(entries, { depth: 0, at: "dup#2", line: undefined, all: false });
    expect(OverviewTree.walkSymbols(byAt.entries).map((shown) => shown.identity.segments)).toEqual([
      [{ name: "dup", disambiguator: 2 }],
    ]);
  });
});
