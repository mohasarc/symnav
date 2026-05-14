import { describe, expect, it } from "vitest";

import type { FileSymbols, SymbolDecl } from "@symnav/core";

import { renderOverviewText } from "./render-overview-text.js";
import { SIGNATURE_CAP_CHARS, SIGNATURE_ELLIPSIS } from "./signature-cap.js";

function decl(
  partial: Partial<Omit<SymbolDecl, "kind">> &
    Pick<SymbolDecl, "name"> & { kind: string },
): SymbolDecl {
  const { kind, ...rest } = partial;
  return {
    range: { startLine: 1, endLine: 1 },
    signatureSource: "",
    children: [],
    ...rest,
    kind: { role: "value", nativeLabel: kind },
  };
}

function assertSingleTrailingNewline(output: string): void {
  expect(output.endsWith("\n")).toBe(true);
  expect(output.endsWith("\n\n")).toBe(false);
}

describe("renderOverviewText", () => {
  it("renders an empty file with header, blank line, and `(no symbols)`", () => {
    const file: FileSymbols = { filePath: "src/empty.ts", symbols: [] };
    const output = renderOverviewText(file);
    expect(output).toBe("Overview: src/empty.ts\n\n(no symbols)\n");
    assertSingleTrailingNewline(output);
  });

  it("renders a single top-level function flat with a 3-space signature indent", () => {
    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "function",
          name: "greet",
          range: { startLine: 4, endLine: 4 },
          signatureSource: "function greet(name: string): void",
        }),
      ],
    };
    const output = renderOverviewText(file);
    expect(output).toBe(
      "Overview: src/file.ts\n\n4: greet\n   function greet(name: string): void\n",
    );
    assertSingleTrailingNewline(output);
  });

  it("ends with exactly one trailing newline for non-empty output", () => {
    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "function",
          name: "greet",
          range: { startLine: 4, endLine: 4 },
          signatureSource: "function greet(): void",
        }),
      ],
    };
    assertSingleTrailingNewline(renderOverviewText(file));
  });

  it("emits a signatureSource shorter than SIGNATURE_CAP_CHARS verbatim", () => {
    const signature = "function greet(name: string): void";
    expect(signature.length).toBeLessThan(SIGNATURE_CAP_CHARS);

    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "function",
          name: "greet",
          range: { startLine: 1, endLine: 1 },
          signatureSource: signature,
        }),
      ],
    };
    expect(renderOverviewText(file)).toContain(`   ${signature}\n`);
  });

  it("truncates a signatureSource longer than SIGNATURE_CAP_CHARS to the cap and appends SIGNATURE_ELLIPSIS", () => {
    const oversized = "x".repeat(SIGNATURE_CAP_CHARS + 50);
    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "function",
          name: "wide",
          range: { startLine: 1, endLine: 1 },
          signatureSource: oversized,
        }),
      ],
    };

    const output = renderOverviewText(file);
    const expectedHead = oversized.slice(0, SIGNATURE_CAP_CHARS - SIGNATURE_ELLIPSIS.length);
    expect(output).toContain(`   ${expectedHead}${SIGNATURE_ELLIPSIS}\n`);
    expect(output).not.toContain(oversized);
  });

  it("separates multiple top-level entries with exactly one blank line", () => {
    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "variable",
          name: "A",
          range: { startLine: 1, endLine: 1 },
          signatureSource: "const A: number",
        }),
        decl({
          kind: "variable",
          name: "B",
          range: { startLine: 3, endLine: 3 },
          signatureSource: "const B: number",
        }),
        decl({
          kind: "variable",
          name: "C",
          range: { startLine: 5, endLine: 5 },
          signatureSource: "const C: number",
        }),
      ],
    };
    expect(renderOverviewText(file)).toBe(
      [
        "Overview: src/file.ts",
        "",
        "1: A",
        "   const A: number",
        "",
        "3: B",
        "   const B: number",
        "",
        "5: C",
        "   const C: number",
        "",
      ].join("\n"),
    );
    assertSingleTrailingNewline(renderOverviewText(file));
  });

  it("renders a class with three methods using `├──`/`└──` and `│   `/`    ` continuations", () => {
    const file: FileSymbols = {
      filePath: "src/checkout.ts",
      symbols: [
        decl({
          kind: "class",
          name: "CheckoutService",
          range: { startLine: 12, endLine: 96 },
          signatureSource: "class CheckoutService",
          children: [
            decl({
              kind: "constructor",
              name: "constructor",
              range: { startLine: 24, endLine: 34 },
              signatureSource: "constructor(p: P, i: I)",
            }),
            decl({
              kind: "method",
              name: "processPayment",
              range: { startLine: 42, endLine: 78 },
              signatureSource: "async processPayment(order: Order): Promise<Receipt>",
            }),
            decl({
              kind: "method",
              name: "validateOrder",
              range: { startLine: 80, endLine: 94 },
              signatureSource: "private validateOrder(order: Order): void",
            }),
          ],
        }),
      ],
    };
    expect(renderOverviewText(file)).toBe(
      [
        "Overview: src/checkout.ts",
        "",
        "12-96: CheckoutService",
        "   class CheckoutService",
        "├── 24-34: CheckoutService::constructor",
        "│   constructor(p: P, i: I)",
        "├── 42-78: CheckoutService::processPayment",
        "│   async processPayment(order: Order): Promise<Receipt>",
        "└── 80-94: CheckoutService::validateOrder",
        "    private validateOrder(order: Order): void",
        "",
      ].join("\n"),
    );
    assertSingleTrailingNewline(renderOverviewText(file));
  });

  it("renders three-deep nesting using `    ` under a closed branch", () => {
    const file: FileSymbols = {
      filePath: "src/nested.ts",
      symbols: [
        decl({
          kind: "namespace",
          name: "Outer",
          range: { startLine: 1, endLine: 50 },
          signatureSource: "namespace Outer",
          children: [
            decl({
              kind: "class",
              name: "Inner",
              range: { startLine: 5, endLine: 40 },
              signatureSource: "class Inner",
              children: [
                decl({
                  kind: "method",
                  name: "method",
                  range: { startLine: 10, endLine: 20 },
                  signatureSource: "method(): void",
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
        "",
        "1-50: Outer",
        "   namespace Outer",
        "└── 5-40: Outer::Inner",
        "    class Inner",
        "    └── 10-20: Outer::Inner::method",
        "        method(): void",
        "",
      ].join("\n"),
    );
  });

  it("formats single-line ranges as `N` and multi-line ranges as `N-M`", () => {
    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "variable",
          name: "single",
          range: { startLine: 8, endLine: 8 },
          signatureSource: "const single: number",
        }),
        decl({
          kind: "function",
          name: "multi",
          range: { startLine: 12, endLine: 96 },
          signatureSource: "function multi(): void",
        }),
      ],
    };
    const output = renderOverviewText(file);
    expect(output).toContain("8: single\n");
    expect(output).toContain("12-96: multi\n");
  });

  it("includes ancestor names joined by `::` in nested symbol paths", () => {
    const file: FileSymbols = {
      filePath: "src/nested.ts",
      symbols: [
        decl({
          kind: "namespace",
          name: "Outer",
          children: [
            decl({
              kind: "class",
              name: "Inner",
              children: [
                decl({
                  kind: "method",
                  name: "deep",
                }),
              ],
            }),
          ],
        }),
      ],
    };
    expect(renderOverviewText(file)).toContain("Outer::Inner::deep");
  });
});
