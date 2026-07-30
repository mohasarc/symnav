import { describe, expect, it } from "vitest";

import { OverviewTree } from "@symnav/core";
import type { OverviewFileEntries, Signature, SymbolOverviewNode } from "@symnav/core";

import { renderOverviewText } from "./render-overview-text.js";
import { SIGNATURE_CAP_LINES, SIGNATURE_ELLIPSIS } from "./signature-cap.js";

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

function signature(startLine: number, ...lines: string[]): Signature {
  return { startLine, lines };
}

function assertSingleTrailingNewline(output: string): void {
  expect(output.endsWith("\n")).toBe(true);
  expect(output.endsWith("\n\n")).toBe(false);
}

describe("renderOverviewText", () => {
  it("renders an empty file with the file path header and `(no symbols)` directly under", () => {
    const file: OverviewFileEntries = { file: "src/empty.ts", entries: [] };
    const output = renderOverviewText(file);
    expect(output).toBe("Overview: src/empty.ts\n(no symbols)\n");
    assertSingleTrailingNewline(output);
  });

  it("renders a single top-level function as the file's only tree child", () => {
    const file: OverviewFileEntries = {
      file: "src/file.ts",
      entries: [
        decl({
          kind: "function",
          segments: [{ name: "greet" }],
          range: { startLine: 4, endLine: 4 },
          header: signature(4, "function greet(name: string): void"),
        }),
      ],
    };
    const output = renderOverviewText(file);
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
    const file: OverviewFileEntries = {
      file: "src/file.ts",
      entries: [
        decl({
          kind: "function",
          segments: [{ name: "greet" }],
          range: { startLine: 4, endLine: 4 },
          header: signature(4, "function greet(): void"),
        }),
      ],
    };
    assertSingleTrailingNewline(renderOverviewText(file));
  });

  it("numbers each line of a multi-line signature from startLine and preserves indentation", () => {
    const file: OverviewFileEntries = {
      file: "src/file.ts",
      entries: [
        decl({
          kind: "function",
          segments: [{ name: "configure" }],
          range: { startLine: 10, endLine: 14 },
          header: signature(10, "function configure(", "  host: string,", "): void"),
        }),
      ],
    };
    expect(renderOverviewText(file)).toBe(
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

  it("returns signature lines at or under SIGNATURE_CAP_LINES unchanged", () => {
    const lines = Array.from({ length: SIGNATURE_CAP_LINES }, (_, i) => `line ${i}`);
    const file: OverviewFileEntries = {
      file: "src/file.ts",
      entries: [
        decl({
          kind: "function",
          segments: [{ name: "wide" }],
          range: { startLine: 1, endLine: SIGNATURE_CAP_LINES },
          header: signature(1, ...lines),
        }),
      ],
    };
    const output = renderOverviewText(file);
    for (let i = 0; i < lines.length; i += 1) {
      expect(output).toContain(`${i + 1} line ${i}\n`);
    }
    expect(output).not.toContain(SIGNATURE_ELLIPSIS);
  });

  it("caps an oversized signature by line count with a final elision marker", () => {
    const lines = Array.from({ length: SIGNATURE_CAP_LINES + 5 }, (_, i) => `line ${i}`);
    const file: OverviewFileEntries = {
      file: "src/file.ts",
      entries: [
        decl({
          kind: "function",
          segments: [{ name: "wide" }],
          range: { startLine: 1, endLine: lines.length },
          header: signature(1, ...lines),
        }),
      ],
    };
    const output = renderOverviewText(file);
    expect(output).toContain(`${SIGNATURE_CAP_LINES} ${SIGNATURE_ELLIPSIS}\n`);
    expect(output).not.toContain(`line ${SIGNATURE_CAP_LINES}`);
  });

  it("renders multiple top-level entries as tree children of the file path", () => {
    const file: OverviewFileEntries = {
      file: "src/file.ts",
      entries: [
        decl({
          kind: "variable",
          segments: [{ name: "A" }],
          range: { startLine: 1, endLine: 1 },
          header: signature(1, "const A: number"),
        }),
        decl({
          kind: "variable",
          segments: [{ name: "B" }],
          range: { startLine: 3, endLine: 3 },
          header: signature(3, "const B: number"),
        }),
        decl({
          kind: "variable",
          segments: [{ name: "C" }],
          range: { startLine: 5, endLine: 5 },
          header: signature(5, "const C: number"),
        }),
      ],
    };
    expect(renderOverviewText(file)).toBe(
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
    assertSingleTrailingNewline(renderOverviewText(file));
  });

  it("renders a class with three methods using `├──`/`└──` and `│   `/`    ` continuations", () => {
    const file: OverviewFileEntries = {
      file: "src/checkout.ts",
      entries: [
        decl({
          kind: "class",
          segments: [{ name: "CheckoutService" }],
          range: { startLine: 12, endLine: 96 },
          header: signature(12, "class CheckoutService"),
          children: [
            decl({
              kind: "constructor",
              segments: [{ name: "CheckoutService" }, { name: "constructor" }],
              range: { startLine: 24, endLine: 34 },
              header: signature(24, "constructor(p: P, i: I)"),
            }),
            decl({
              kind: "method",
              segments: [{ name: "CheckoutService" }, { name: "processPayment" }],
              range: { startLine: 42, endLine: 78 },
              header: signature(42, "async processPayment(order: Order): Promise<Receipt>"),
            }),
            decl({
              kind: "method",
              segments: [{ name: "CheckoutService" }, { name: "validateOrder" }],
              range: { startLine: 80, endLine: 94 },
              header: signature(80, "private validateOrder(order: Order): void"),
            }),
          ],
        }),
      ],
    };
    expect(renderOverviewText(file)).toBe(
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
    assertSingleTrailingNewline(renderOverviewText(file));
  });

  it("numbers a nested symbol's multi-line signature under its continuation glyph", () => {
    const file: OverviewFileEntries = {
      file: "src/server.ts",
      entries: [
        decl({
          kind: "class",
          segments: [{ name: "Server" }],
          range: { startLine: 1, endLine: 10 },
          header: signature(1, "class Server"),
          children: [
            decl({
              kind: "method",
              segments: [{ name: "Server" }, { name: "start" }],
              range: { startLine: 2, endLine: 6 },
              header: signature(2, "start(", "  host: string,", "): void"),
            }),
          ],
        }),
      ],
    };
    expect(renderOverviewText(file)).toBe(
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
    const file: OverviewFileEntries = {
      file: "src/nested.ts",
      entries: [
        decl({
          kind: "namespace",
          segments: [{ name: "Outer" }],
          range: { startLine: 1, endLine: 50 },
          header: signature(1, "namespace Outer"),
          children: [
            decl({
              kind: "class",
              segments: [{ name: "Outer" }, { name: "Inner" }],
              range: { startLine: 5, endLine: 40 },
              header: signature(5, "class Inner"),
              children: [
                decl({
                  kind: "method",
                  segments: [{ name: "Outer" }, { name: "Inner" }, { name: "method" }],
                  range: { startLine: 10, endLine: 20 },
                  header: signature(10, "method(): void"),
                }),
              ],
            }),
          ],
        }),
      ],
    };
    expect(renderOverviewText(file)).toBe(
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
    const file: OverviewFileEntries = {
      file: "src/file.ts",
      entries: [
        decl({
          kind: "variable",
          segments: [{ name: "single" }],
          range: { startLine: 8, endLine: 8 },
          header: signature(8, "const single: number"),
        }),
        decl({
          kind: "function",
          segments: [{ name: "multi" }],
          range: { startLine: 12, endLine: 96 },
          header: signature(12, "function multi(): void"),
        }),
      ],
    };
    const output = renderOverviewText(file);
    expect(output).toContain("8: single\n");
    expect(output).toContain("12-96: multi\n");
  });

  it("includes ancestor names joined by `::` in nested symbol paths", () => {
    const file: OverviewFileEntries = {
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
    };
    expect(renderOverviewText(file)).toContain("Outer::Inner::deep");
  });

  it("renders fold-nested symbols at the containing nesting level, hiding the fold itself", () => {
    const file: OverviewFileEntries = {
      file: "src/folds.ts",
      entries: [
        decl({
          kind: "function",
          segments: [{ name: "outer" }],
          range: { startLine: 1, endLine: 5 },
          header: signature(1, "function outer(): void"),
          children: [
            OverviewTree.fold({
              foldKind: "conditional",
              range: { startLine: 2, endLine: 4 },
              header: signature(2, "if (enabled)"),
              children: [
                decl({
                  kind: "function",
                  segments: [{ name: "outer" }, { name: "insideIf" }],
                  range: { startLine: 3, endLine: 3 },
                  header: signature(3, "function insideIf(): void"),
                }),
              ],
            }),
          ],
        }),
      ],
    };
    const output = renderOverviewText(file);
    expect(output).toBe(
      [
        "Overview: src/folds.ts",
        "└── 1-5: outer",
        "    1 function outer(): void",
        "    └── 3: outer::insideIf",
        "        3 function insideIf(): void",
        "",
      ].join("\n"),
    );
    expect(output).not.toContain("if (enabled)");
  });

  it("drops re-export entries from the rendered tree", () => {
    const file: OverviewFileEntries = {
      file: "src/re-exports.ts",
      entries: [
        OverviewTree.reExport({
          exportKind: "named",
          exportedNames: ["m"],
          sourceModule: "./other.js",
          range: { startLine: 1, endLine: 1 },
          header: signature(1, "export { m } from './other.js'"),
        }),
        decl({
          kind: "function",
          segments: [{ name: "kept" }],
          range: { startLine: 2, endLine: 2 },
          header: signature(2, "function kept(): void"),
        }),
      ],
    };
    const output = renderOverviewText(file);
    expect(output).toBe(
      ["Overview: src/re-exports.ts", "└── 2: kept", "    2 function kept(): void", ""].join("\n"),
    );
  });
});
