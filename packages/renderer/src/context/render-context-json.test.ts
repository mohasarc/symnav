import { describe, expect, it } from "vitest";

import type { ContextResult, ReferenceKind, SymbolOverviewNode } from "@symnav/core";

import { renderContextJson } from "./render-context-json.js";

function emptyKindCounts(): Record<ReferenceKind, number> {
  return { usage: 0, import: 0, export: 0, type: 0 };
}

describe("renderContextJson", () => {
  it("serializes the result verbatim with a trailing newline", () => {
    const target: SymbolOverviewNode = {
      type: "symbol",
      identity: {
        file: "src/checkout/CheckoutService.ts",
        segments: [{ name: "CheckoutService" }, { name: "processPayment" }],
      },
      kind: { role: "callable", nativeLabel: "method-implementation" },
      range: { startLine: 42, endLine: 78 },
      header: { startLine: 42, lines: ["async processPayment(order: Order): Promise<Receipt>"] },
      children: [],
    };
    const result: ContextResult = {
      identity: target.identity,
      target,
      definitions: [target],
      callers: {
        sortedEdges: [
          {
            symbol: {
              type: "symbol",
              identity: {
                file: "src/api/CheckoutController.ts",
                segments: [{ name: "CheckoutController" }, { name: "submitOrder" }],
              },
              kind: { role: "callable", nativeLabel: "method-implementation" },
              range: { startLine: 58, endLine: 72 },
              header: { startLine: 58, lines: ["async submitOrder(): Promise<void>"] },
              children: [],
            },
            sites: [
              {
                file: "src/api/CheckoutController.ts",
                line: 60,
                previewSource: "return checkoutService.processPayment(order)",
                matchStart: 0,
                matchEnd: 4,
              },
            ],
            confidence: "certain",
          },
        ],
        omittedCertainEdgeCount: 0,
      },
      callees: { sortedEdges: [], omittedCertainEdgeCount: 0 },
      references: { total: 8, kindCounts: { ...emptyKindCounts(), usage: 8 } },
      history: [
        {
          shortSha: "abc123f",
          isoDate: "2026-04-12",
          author: "Alice",
          subject: "add retry handling",
        },
      ],
    };

    expect(renderContextJson(result)).toBe(`${JSON.stringify(result)}\n`);
  });
});
