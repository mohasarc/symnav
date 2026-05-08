import type { FileSymbols, SymbolDecl } from "@symnav/core";
import { describe, expect, it } from "vitest";
import { renderOverviewJson, renderOverviewText } from "./overview.js";

function decl(partial: Partial<SymbolDecl> & Pick<SymbolDecl, "name">): SymbolDecl {
  return {
    kind: partial.kind ?? "function",
    name: partial.name,
    range: partial.range ?? { startLine: 1, endLine: 1 },
    signature: partial.signature ?? `function ${partial.name}()`,
    children: partial.children ?? [],
  };
}

function assertTrailingNewline(out: string): void {
  expect(out.endsWith("\n")).toBe(true);
  // Exactly one trailing newline.
  expect(out.endsWith("\n\n")).toBe(false);
}

describe("renderOverviewText", () => {
  it("renders an empty file as header + blank line + (no symbols) + trailing newline", () => {
    const file: FileSymbols = { filePath: "src/empty.ts", symbols: [] };
    const out = renderOverviewText(file);
    expect(out).toBe("Overview: src/empty.ts\n\n(no symbols)\n");
    assertTrailingNewline(out);
  });

  it("renders a single top-level function flat with 3-space-indented signature", () => {
    const file: FileSymbols = {
      filePath: "src/x.ts",
      symbols: [
        decl({
          name: "greet",
          range: { startLine: 4, endLine: 6 },
          signature: "function greet(name: string): string",
        }),
      ],
    };
    const out = renderOverviewText(file);
    expect(out).toMatchInlineSnapshot(`
      "Overview: src/x.ts

      4-6: greet
         function greet(name: string): string
      "
    `);
    assertTrailingNewline(out);
  });

  it("separates multiple top-level entries with a single blank line each", () => {
    const file: FileSymbols = {
      filePath: "src/m.ts",
      symbols: [
        decl({
          name: "A",
          range: { startLine: 1, endLine: 1 },
          signature: "const A: number",
          kind: "variable",
        }),
        decl({
          name: "B",
          range: { startLine: 3, endLine: 3 },
          signature: "const B: number",
          kind: "variable",
        }),
        decl({
          name: "C",
          range: { startLine: 5, endLine: 5 },
          signature: "const C: number",
          kind: "variable",
        }),
      ],
    };
    const out = renderOverviewText(file);
    expect(out).toMatchInlineSnapshot(`
      "Overview: src/m.ts

      1: A
         const A: number

      3: B
         const B: number

      5: C
         const C: number
      "
    `);
    // Exactly two blank-line separators between three entries.
    const blankSeparators = out.split("\n\n").length - 1;
    // header blank line + 2 inter-entry blank lines = 3
    expect(blankSeparators).toBe(3);
    assertTrailingNewline(out);
  });

  it("renders a class with three methods using ├── / └── and │   /     prefixes", () => {
    const cls = decl({
      name: "CheckoutService",
      kind: "class",
      range: { startLine: 12, endLine: 96 },
      signature: "class CheckoutService",
      children: [
        decl({
          name: "constructor",
          kind: "constructor",
          range: { startLine: 24, endLine: 34 },
          signature: "constructor(paymentProcessor: PaymentProcessor, inventory: InventoryService)",
        }),
        decl({
          name: "processPayment",
          kind: "method",
          range: { startLine: 42, endLine: 78 },
          signature: "async processPayment(order: Order): Promise<Receipt>",
        }),
        decl({
          name: "validateOrder",
          kind: "method",
          range: { startLine: 80, endLine: 94 },
          signature: "private validateOrder(order: Order): void",
        }),
      ],
    });
    const file: FileSymbols = {
      filePath: "src/checkout/CheckoutService.ts",
      symbols: [cls],
    };
    const out = renderOverviewText(file);
    expect(out).toMatchInlineSnapshot(`
      "Overview: src/checkout/CheckoutService.ts

      12-96: CheckoutService
         class CheckoutService
      ├── 24-34: CheckoutService::constructor
      │   constructor(paymentProcessor: PaymentProcessor, inventory: InventoryService)
      ├── 42-78: CheckoutService::processPayment
      │   async processPayment(order: Order): Promise<Receipt>
      └── 80-94: CheckoutService::validateOrder
          private validateOrder(order: Order): void
      "
    `);
    assertTrailingNewline(out);
  });

  it("renders three-deep nesting (namespace → class → method) with cumulative prefixes", () => {
    const file: FileSymbols = {
      filePath: "src/deep.ts",
      symbols: [
        decl({
          name: "Outer",
          kind: "namespace",
          range: { startLine: 1, endLine: 12 },
          signature: "namespace Outer",
          children: [
            decl({
              name: "Inner",
              kind: "class",
              range: { startLine: 2, endLine: 11 },
              signature: "class Inner",
              children: [
                decl({
                  name: "method",
                  kind: "method",
                  range: { startLine: 4, endLine: 9 },
                  signature: "method(): void",
                }),
              ],
            }),
          ],
        }),
      ],
    };
    const out = renderOverviewText(file);
    expect(out).toMatchInlineSnapshot(`
      "Overview: src/deep.ts

      1-12: Outer
         namespace Outer
      └── 2-11: Outer::Inner
          class Inner
          └── 4-9: Outer::Inner::method
              method(): void
      "
    `);
    assertTrailingNewline(out);
  });

  it("renders single-line range as N and multi-line range as N-M", () => {
    const file: FileSymbols = {
      filePath: "src/r.ts",
      symbols: [
        decl({
          name: "single",
          range: { startLine: 8, endLine: 8 },
          signature: "function single(): void",
        }),
        decl({
          name: "multi",
          range: { startLine: 12, endLine: 96 },
          signature: "function multi(): void",
        }),
      ],
    };
    const out = renderOverviewText(file);
    expect(out).toContain("8: single");
    expect(out).toContain("12-96: multi");
    expect(out).not.toContain("8-8:");
    assertTrailingNewline(out);
  });

  it("includes ancestors joined by :: in the symbol path of a nested decl", () => {
    const file: FileSymbols = {
      filePath: "src/p.ts",
      symbols: [
        decl({
          name: "C",
          kind: "class",
          range: { startLine: 1, endLine: 5 },
          signature: "class C",
          children: [
            decl({
              name: "m",
              kind: "method",
              range: { startLine: 2, endLine: 4 },
              signature: "m(): void",
            }),
          ],
        }),
      ],
    };
    const out = renderOverviewText(file);
    expect(out).toContain("C::m");
    assertTrailingNewline(out);
  });
});

describe("renderOverviewJson", () => {
  it("mirrors FileSymbols verbatim with children always present (empty array on leaves)", () => {
    const file: FileSymbols = {
      filePath: "src/x.ts",
      symbols: [
        decl({
          name: "C",
          kind: "class",
          range: { startLine: 1, endLine: 5 },
          signature: "class C",
          children: [
            decl({
              name: "m",
              kind: "method",
              range: { startLine: 2, endLine: 4 },
              signature: "m(): void",
            }),
          ],
        }),
      ],
    };
    const out = renderOverviewJson(file);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      filePath: "src/x.ts",
      symbols: [
        {
          children: [
            {
              children: [],
              kind: "method",
              name: "m",
              range: { endLine: 4, startLine: 2 },
              signature: "m(): void",
            },
          ],
          kind: "class",
          name: "C",
          range: { endLine: 5, startLine: 1 },
          signature: "class C",
        },
      ],
    });
    // children key must exist on the leaf, not be omitted.
    expect(out).toMatch(/"children":\s*\[\]/);
  });

  it("emits 2-space-indented JSON with sorted keys and a trailing newline", () => {
    const file: FileSymbols = {
      filePath: "src/x.ts",
      symbols: [
        decl({
          name: "f",
          kind: "function",
          range: { startLine: 1, endLine: 1 },
          signature: "function f()",
        }),
      ],
    };
    const out = renderOverviewJson(file);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toMatchInlineSnapshot(`
      "{
        "filePath": "src/x.ts",
        "symbols": [
          {
            "children": [],
            "kind": "function",
            "name": "f",
            "range": {
              "endLine": 1,
              "startLine": 1
            },
            "signature": "function f()"
          }
        ]
      }
      "
    `);
  });

  it("produces byte-identical output across two calls on the same IR", () => {
    const file: FileSymbols = {
      filePath: "src/x.ts",
      symbols: [
        decl({
          name: "C",
          kind: "class",
          range: { startLine: 1, endLine: 10 },
          signature: "class C",
          children: [
            decl({
              name: "b",
              kind: "method",
              range: { startLine: 6, endLine: 8 },
              signature: "b(): void",
            }),
            decl({
              name: "a",
              kind: "method",
              range: { startLine: 2, endLine: 4 },
              signature: "a(): void",
            }),
          ],
        }),
      ],
    };
    expect(renderOverviewJson(file)).toBe(renderOverviewJson(file));
  });
});
