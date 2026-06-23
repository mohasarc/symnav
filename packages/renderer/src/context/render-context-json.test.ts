import { describe, expect, it } from "vitest";

import type { ContextResult, ReferenceKind } from "@symnav/core";

import { renderContextJson } from "./render-context-json.js";

function emptyKindCounts(): Record<ReferenceKind, number> {
  return { usage: 0, import: 0, export: 0, type: 0 };
}

describe("renderContextJson", () => {
  it("serializes the result verbatim with a trailing newline", () => {
    const target = {
      identity: {
        file: "src/checkout/CheckoutService.ts",
        segments: [{ name: "CheckoutService" }, { name: "processPayment" }],
      },
      kind: { role: "callable" as const, nativeLabel: "method-implementation" },
      range: { startLine: 42, endLine: 78 },
      signature: { startLine: 42, lines: ["async processPayment(order: Order): Promise<Receipt>"] },
      children: [],
    };
    const result: ContextResult = {
      identity: target.identity,
      target,
      definitions: [target],
      callers: {
        edges: [
          {
            symbol: {
              identity: {
                file: "src/api/CheckoutController.ts",
                segments: [{ name: "CheckoutController" }, { name: "submitOrder" }],
              },
              kind: { role: "callable", nativeLabel: "method-implementation" },
              range: { startLine: 58, endLine: 72 },
              signature: { startLine: 58, lines: ["async submitOrder(): Promise<void>"] },
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
        overflow: 0,
      },
      callees: { edges: [], overflow: 0 },
      references: { total: 8, kindCounts: { ...emptyKindCounts(), usage: 8 } },
      history: [
        { sha: "abc123f", date: "2026-04-12", author: "Alice", subject: "add retry handling" },
      ],
    };

    expect(renderContextJson(result)).toBe(`${JSON.stringify(result)}\n`);
  });
});
