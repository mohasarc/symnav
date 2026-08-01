import { describe, expect, it } from "vitest";

import type {
  FoldOverviewNode,
  OverviewExpansionResult,
  ReExportOverviewNode,
  Header,
  SymbolOverviewNode,
} from "@symnav/core";

import { renderOverviewText } from "./render-overview-text.js";
import { HEADER_CAP_LINES, HEADER_CAP_LINE_LENGTH, HEADER_ELLIPSIS } from "./header-cap.js";

type DeclPartial = Pick<SymbolOverviewNode["identity"], "segments"> &
  Partial<Pick<SymbolOverviewNode, "range" | "header" | "children">> & {
    readonly kind: string;
  };

function decl(partial: DeclPartial, file: string = "src/file.ts"): SymbolOverviewNode {
  return {
    type: "symbol",
    identity: { file, segments: partial.segments },
    kind: { role: "value", nativeLabel: partial.kind },
    range: partial.range ?? { startLine: 1, endLine: 1 },
    header: partial.header ?? { startLine: 1, lines: [""] },
    children: partial.children ?? [],
  };
}

function fold(
  partial: Partial<Pick<FoldOverviewNode, "range" | "header" | "children">> = {},
): FoldOverviewNode {
  return {
    type: "fold",
    foldKind: "call",
    range: partial.range ?? { startLine: 1, endLine: 3 },
    header: partial.header ?? header(1, 'describe("x", () => {'),
    children: partial.children ?? [],
  };
}

function reExport(
  partial: Partial<Pick<ReExportOverviewNode, "range" | "header">> = {},
): ReExportOverviewNode {
  return {
    type: "re-export",
    exportKind: "star",
    exportedNames: [],
    sourceModule: "./core",
    range: partial.range ?? { startLine: 1, endLine: 1 },
    header: partial.header ?? header(1, 'export * from "./core";'),
  };
}

function header(startLine: number, ...lines: string[]): Header {
  return { startLine, lines };
}

function overviewResult(
  partial: Omit<OverviewExpansionResult, "request" | "totalSymbolCount">,
): OverviewExpansionResult {
  return {
    ...partial,
    request: { depth: 0, at: undefined, line: undefined },
    totalSymbolCount: 0,
  };
}

function assertSingleTrailingNewline(output: string): void {
  expect(output.endsWith("\n")).toBe(true);
  expect(output.endsWith("\n\n")).toBe(false);
}

describe("renderOverviewText", () => {
  it("renders an empty file with the file path header and `(no symbols)` directly under", () => {
    const result = overviewResult({ file: "src/empty.ts", entries: [] });
    const output = renderOverviewText(result);
    expect(output).toBe("Overview: src/empty.ts\n(no symbols)\n");
    assertSingleTrailingNewline(output);
  });

  it("renders a single top-level function as the file's only tree child", () => {
    const result = overviewResult({
      file: "src/file.ts",
      entries: [
        decl({
          kind: "function",
          segments: [{ name: "greet" }],
          range: { startLine: 4, endLine: 4 },
          header: header(4, "function greet(name: string): void"),
        }),
      ],
    });
    const output = renderOverviewText(result);
    expect(output).toBe(
      [
        "Overview: src/file.ts",
        "└── 4: greet",
        "    4 function greet(name: string): void",
        "",
      ].join("\n"),
    );
    assertSingleTrailingNewline(output);
  });

  it("ends with exactly one trailing newline for non-empty output", () => {
    const result = overviewResult({
      file: "src/file.ts",
      entries: [
        decl({
          kind: "function",
          segments: [{ name: "greet" }],
          range: { startLine: 4, endLine: 4 },
          header: header(4, "function greet(): void"),
        }),
      ],
    });
    assertSingleTrailingNewline(renderOverviewText(result));
  });

  it("numbers each line of a multi-line signature from startLine and preserves indentation", () => {
    const result = overviewResult({
      file: "src/file.ts",
      entries: [
        decl({
          kind: "function",
          segments: [{ name: "configure" }],
          range: { startLine: 10, endLine: 14 },
          header: header(10, "function configure(", "  host: string,", "): void"),
        }),
      ],
    });
    expect(renderOverviewText(result)).toBe(
      [
        "Overview: src/file.ts",
        "└── 10-14: configure",
        "    10 function configure(",
        "    11   host: string,",
        "    12 ): void",
        "",
      ].join("\n"),
    );
  });

  it("returns signature lines at or under HEADER_CAP_LINES unchanged", () => {
    const lines = Array.from({ length: HEADER_CAP_LINES }, (_, i) => `line ${i}`);
    const result = overviewResult({
      file: "src/file.ts",
      entries: [
        decl({
          kind: "function",
          segments: [{ name: "wide" }],
          range: { startLine: 1, endLine: HEADER_CAP_LINES },
          header: header(1, ...lines),
        }),
      ],
    });
    const output = renderOverviewText(result);
    for (let i = 0; i < lines.length; i += 1) {
      expect(output).toContain(`${i + 1} line ${i}\n`);
    }
    expect(output).not.toContain(HEADER_ELLIPSIS);
  });

  it("caps an oversized signature by line count with a final elision marker", () => {
    const lines = Array.from({ length: HEADER_CAP_LINES + 5 }, (_, i) => `line ${i}`);
    const result = overviewResult({
      file: "src/file.ts",
      entries: [
        decl({
          kind: "function",
          segments: [{ name: "wide" }],
          range: { startLine: 1, endLine: lines.length },
          header: header(1, ...lines),
        }),
      ],
    });
    const output = renderOverviewText(result);
    expect(output).toContain(`${HEADER_CAP_LINES} ${HEADER_ELLIPSIS}\n`);
    expect(output).not.toContain(`line ${HEADER_CAP_LINES}`);
  });

  it("renders multiple top-level entries as tree children of the file path", () => {
    const result = overviewResult({
      file: "src/file.ts",
      entries: [
        decl({
          kind: "variable",
          segments: [{ name: "A" }],
          range: { startLine: 1, endLine: 1 },
          header: header(1, "const A: number"),
        }),
        decl({
          kind: "variable",
          segments: [{ name: "B" }],
          range: { startLine: 3, endLine: 3 },
          header: header(3, "const B: number"),
        }),
        decl({
          kind: "variable",
          segments: [{ name: "C" }],
          range: { startLine: 5, endLine: 5 },
          header: header(5, "const C: number"),
        }),
      ],
    });
    expect(renderOverviewText(result)).toBe(
      [
        "Overview: src/file.ts",
        "├── 1: A",
        "│   1 const A: number",
        "│",
        "├── 3: B",
        "│   3 const B: number",
        "│",
        "└── 5: C",
        "    5 const C: number",
        "",
      ].join("\n"),
    );
    assertSingleTrailingNewline(renderOverviewText(result));
  });

  it("renders a class with three methods using `├──`/`└──` and `│   `/`    ` continuations", () => {
    const result = overviewResult({
      file: "src/checkout.ts",
      entries: [
        decl({
          kind: "class",
          segments: [{ name: "CheckoutService" }],
          range: { startLine: 12, endLine: 96 },
          header: header(12, "class CheckoutService"),
          children: [
            decl({
              kind: "constructor",
              segments: [{ name: "CheckoutService" }, { name: "constructor" }],
              range: { startLine: 24, endLine: 34 },
              header: header(24, "constructor(p: P, i: I)"),
            }),
            decl({
              kind: "method",
              segments: [{ name: "CheckoutService" }, { name: "processPayment" }],
              range: { startLine: 42, endLine: 78 },
              header: header(42, "async processPayment(order: Order): Promise<Receipt>"),
            }),
            decl({
              kind: "method",
              segments: [{ name: "CheckoutService" }, { name: "validateOrder" }],
              range: { startLine: 80, endLine: 94 },
              header: header(80, "private validateOrder(order: Order): void"),
            }),
          ],
        }),
      ],
    });
    expect(renderOverviewText(result)).toBe(
      [
        "Overview: src/checkout.ts",
        "└── 12-96: CheckoutService",
        "    12 class CheckoutService",
        "    ├── 24-34: CheckoutService::constructor",
        "    │   24 constructor(p: P, i: I)",
        "    ├── 42-78: CheckoutService::processPayment",
        "    │   42 async processPayment(order: Order): Promise<Receipt>",
        "    └── 80-94: CheckoutService::validateOrder",
        "        80 private validateOrder(order: Order): void",
        "",
      ].join("\n"),
    );
    assertSingleTrailingNewline(renderOverviewText(result));
  });

  it("numbers a nested symbol's multi-line signature under its continuation glyph", () => {
    const result = overviewResult({
      file: "src/server.ts",
      entries: [
        decl({
          kind: "class",
          segments: [{ name: "Server" }],
          range: { startLine: 1, endLine: 10 },
          header: header(1, "class Server"),
          children: [
            decl({
              kind: "method",
              segments: [{ name: "Server" }, { name: "start" }],
              range: { startLine: 2, endLine: 6 },
              header: header(2, "start(", "  host: string,", "): void"),
            }),
          ],
        }),
      ],
    });
    expect(renderOverviewText(result)).toBe(
      [
        "Overview: src/server.ts",
        "└── 1-10: Server",
        "    1 class Server",
        "    └── 2-6: Server::start",
        "        2 start(",
        "        3   host: string,",
        "        4 ): void",
        "",
      ].join("\n"),
    );
  });

  it("renders three-deep nesting using `    ` under a closed branch", () => {
    const result = overviewResult({
      file: "src/nested.ts",
      entries: [
        decl({
          kind: "namespace",
          segments: [{ name: "Outer" }],
          range: { startLine: 1, endLine: 50 },
          header: header(1, "namespace Outer"),
          children: [
            decl({
              kind: "class",
              segments: [{ name: "Outer" }, { name: "Inner" }],
              range: { startLine: 5, endLine: 40 },
              header: header(5, "class Inner"),
              children: [
                decl({
                  kind: "method",
                  segments: [{ name: "Outer" }, { name: "Inner" }, { name: "method" }],
                  range: { startLine: 10, endLine: 20 },
                  header: header(10, "method(): void"),
                }),
              ],
            }),
          ],
        }),
      ],
    });
    expect(renderOverviewText(result)).toBe(
      [
        "Overview: src/nested.ts",
        "└── 1-50: Outer",
        "    1 namespace Outer",
        "    └── 5-40: Outer::Inner",
        "        5 class Inner",
        "        └── 10-20: Outer::Inner::method",
        "            10 method(): void",
        "",
      ].join("\n"),
    );
  });

  it("formats single-line ranges as `N` and multi-line ranges as `N-M`", () => {
    const result = overviewResult({
      file: "src/file.ts",
      entries: [
        decl({
          kind: "variable",
          segments: [{ name: "single" }],
          range: { startLine: 8, endLine: 8 },
          header: header(8, "const single: number"),
        }),
        decl({
          kind: "function",
          segments: [{ name: "multi" }],
          range: { startLine: 12, endLine: 96 },
          header: header(12, "function multi(): void"),
        }),
      ],
    });
    const output = renderOverviewText(result);
    expect(output).toContain("8: single\n");
    expect(output).toContain("12-96: multi\n");
  });

  it("includes ancestor names joined by `::` in nested symbol paths", () => {
    const result = overviewResult({
      file: "src/nested.ts",
      entries: [
        decl({
          kind: "namespace",
          segments: [{ name: "Outer" }],
          children: [
            decl({
              kind: "class",
              segments: [{ name: "Outer" }, { name: "Inner" }],
              children: [
                decl({
                  kind: "method",
                  segments: [{ name: "Outer" }, { name: "Inner" }, { name: "deep" }],
                }),
              ],
            }),
          ],
        }),
      ],
    });
    expect(renderOverviewText(result)).toContain("Outer::Inner::deep");
  });

  it("renders fold nodes as header-only tree entries with nested symbols", () => {
    const result = overviewResult({
      file: "src/fold.ts",
      entries: [
        fold({
          range: { startLine: 1, endLine: 3 },
          header: header(1, 'describe("x", () => {'),
          children: [
            decl({
              kind: "variable",
              segments: [{ name: "helper" }],
              range: { startLine: 2, endLine: 2 },
              header: header(2, "const helper = () => …"),
            }),
          ],
        }),
      ],
    });

    expect(renderOverviewText(result)).toBe(
      [
        "Overview: src/fold.ts",
        '└── 1-3: describe("x", () => {',
        "    └── 2: helper",
        "        2 const helper = () => …",
        "",
      ].join("\n"),
    );
  });

  it("renders a multi-line fold header as numbered continuation lines inside the tree", () => {
    const result = overviewResult({
      file: "src/fold.ts",
      entries: [
        fold({
          range: { startLine: 1, endLine: 6 },
          header: header(1, "if (", "  flag &&", ") {"),
          children: [
            decl({
              kind: "function",
              segments: [{ name: "insideIf" }],
              range: { startLine: 5, endLine: 5 },
              header: header(5, "function insideIf(): void"),
            }),
          ],
        }),
      ],
    });

    expect(renderOverviewText(result)).toBe(
      [
        "Overview: src/fold.ts",
        "└── 1-6: if (",
        "    2   flag &&",
        "    3 ) {",
        "    └── 5: insideIf",
        "        5 function insideIf(): void",
        "",
      ].join("\n"),
    );
  });

  it("renders a nested multi-line fold header under the open-branch continuation glyph", () => {
    const result = overviewResult({
      file: "src/fold.ts",
      entries: [
        fold({
          range: { startLine: 1, endLine: 4 },
          header: header(1, "while (", ") {"),
        }),
        fold({
          range: { startLine: 6, endLine: 8 },
          header: header(6, "block {"),
        }),
      ],
    });

    expect(renderOverviewText(result)).toBe(
      ["Overview: src/fold.ts", "├── 1-4: while (", "│   2 ) {", "│", "└── 6-8: block {", ""].join(
        "\n",
      ),
    );
  });

  it("renders a multi-line re-export header as numbered continuation lines", () => {
    const result = overviewResult({
      file: "src/index.ts",
      entries: [
        reExport({
          range: { startLine: 1, endLine: 3 },
          header: header(1, "export {", "  A,", '} from "./api";'),
        }),
      ],
    });

    expect(renderOverviewText(result)).toBe(
      [
        "Overview: src/index.ts",
        "└── 1-3: export {",
        "    2   A,",
        '    3 } from "./api";',
        "",
      ].join("\n"),
    );
  });

  it("caps fold continuation lines at HEADER_CAP_LINES with a final elision marker", () => {
    const lines = Array.from({ length: HEADER_CAP_LINES + 5 }, (_, i) => `condition ${i} &&`);
    const result = overviewResult({
      file: "src/fold.ts",
      entries: [
        fold({
          range: { startLine: 1, endLine: lines.length + 1 },
          header: header(1, ...lines),
        }),
      ],
    });

    const output = renderOverviewText(result);
    expect(output).toContain(`${HEADER_CAP_LINES} ${HEADER_ELLIPSIS}\n`);
    expect(output).not.toContain(`condition ${HEADER_CAP_LINES}`);
  });

  it("caps an over-length fold label at HEADER_CAP_LINE_LENGTH with a final elision marker", () => {
    const label = `call(${"a".repeat(100)}) {`;
    const result = overviewResult({
      file: "src/fold.ts",
      entries: [fold({ range: { startLine: 1, endLine: 3 }, header: header(1, label) })],
    });

    const cappedLabel = label.slice(0, HEADER_CAP_LINE_LENGTH - 1) + HEADER_ELLIPSIS;
    expect(cappedLabel).toHaveLength(HEADER_CAP_LINE_LENGTH);
    expect(renderOverviewText(result)).toBe(
      ["Overview: src/fold.ts", `└── 1-3: ${cappedLabel}`, ""].join("\n"),
    );
  });

  it("renders a fold label of exactly HEADER_CAP_LINE_LENGTH characters untouched", () => {
    const label = "y".repeat(HEADER_CAP_LINE_LENGTH);
    const result = overviewResult({
      file: "src/fold.ts",
      entries: [fold({ range: { startLine: 1, endLine: 3 }, header: header(1, label) })],
    });

    const output = renderOverviewText(result);
    expect(output).toContain(`└── 1-3: ${label}\n`);
    expect(output).not.toContain(HEADER_ELLIPSIS);
  });

  it("caps over-length re-export label and continuation lines", () => {
    const label = `export { ${"A".repeat(100)}`;
    const continuation = `  ${"B".repeat(100)},`;
    const result = overviewResult({
      file: "src/index.ts",
      entries: [
        reExport({
          range: { startLine: 1, endLine: 3 },
          header: header(1, label, continuation, '} from "./api";'),
        }),
      ],
    });

    const cappedLabel = label.slice(0, HEADER_CAP_LINE_LENGTH - 1) + HEADER_ELLIPSIS;
    const cappedContinuation = continuation.slice(0, HEADER_CAP_LINE_LENGTH - 1) + HEADER_ELLIPSIS;
    expect(renderOverviewText(result)).toBe(
      [
        "Overview: src/index.ts",
        `└── 1-3: ${cappedLabel}`,
        `    2 ${cappedContinuation}`,
        '    3 } from "./api";',
        "",
      ].join("\n"),
    );
  });

  it("renders over-length symbol header lines untouched", () => {
    const longSignature = `function wide(${"a".repeat(100)}): void`;
    const result = overviewResult({
      file: "src/file.ts",
      entries: [
        decl({
          kind: "function",
          segments: [{ name: "wide" }],
          range: { startLine: 1, endLine: 1 },
          header: header(1, longSignature),
        }),
      ],
    });

    const output = renderOverviewText(result);
    expect(output).toContain(`1 ${longSignature}\n`);
    expect(output).not.toContain(HEADER_ELLIPSIS);
  });

  it("renders re-export nodes as header-only tree entries", () => {
    const result = overviewResult({
      file: "src/index.ts",
      entries: [
        reExport({
          range: { startLine: 1, endLine: 1 },
          header: header(1, 'export * from "./core";'),
        }),
      ],
    });

    expect(renderOverviewText(result)).toBe(
      ["Overview: src/index.ts", '└── 1: export * from "./core";', ""].join("\n"),
    );
  });
});
