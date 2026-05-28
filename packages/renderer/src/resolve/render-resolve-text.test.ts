import { describe, expect, it } from "vitest";

import type { ResolveResult, Signature, SymbolDecl, SymbolPathSegment } from "@symnav/core";

import { renderResolveText } from "./render-resolve-text.js";

interface DeclInput {
  readonly file: string;
  readonly segments: readonly SymbolPathSegment[];
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: readonly string[];
}

function decl(input: DeclInput): SymbolDecl {
  const sig: Signature = { startLine: input.startLine, lines: input.signature };
  return {
    identity: { file: input.file, segments: input.segments },
    kind: { role: "value", nativeLabel: input.kind },
    range: { startLine: input.startLine, endLine: input.endLine },
    signature: sig,
    children: [],
  };
}

describe("renderResolveText", () => {
  it("renders the canonical multi-file Payment example", () => {
    const result: ResolveResult = {
      query: "Payment",
      fuzzy: true,
      symbols: [
        decl({
          file: "src/checkout/CheckoutService.ts",
          segments: [{ name: "MAX_PAYMENT_RETRIES" }],
          kind: "variable",
          startLine: 8,
          endLine: 8,
          signature: ["const MAX_PAYMENT_RETRIES: number"],
        }),
        decl({
          file: "src/checkout/CheckoutService.ts",
          segments: [{ name: "CheckoutService" }, { name: "processPayment" }],
          kind: "method",
          startLine: 42,
          endLine: 78,
          signature: ["async processPayment(order: Order): Promise<Receipt>"],
        }),
        decl({
          file: "src/payments/PaymentProvider.ts",
          segments: [{ name: "PaymentProvider" }],
          kind: "interface",
          startLine: 2,
          endLine: 5,
          signature: ["interface PaymentProvider"],
        }),
      ],
      files: ["src/checkout/CheckoutService.ts", "src/payments/PaymentProvider.ts"],
    };
    const output = renderResolveText(result);
    expect(output).toBe(
      [
        "Resolve: Payment",
        "",
        "Symbols",
        "├── src/checkout/CheckoutService.ts",
        "│   ├── 8: MAX_PAYMENT_RETRIES",
        "│   │   const MAX_PAYMENT_RETRIES: number",
        "│   └── 42-78: CheckoutService::processPayment",
        "│       async processPayment(order: Order): Promise<Receipt>",
        "└── src/payments/PaymentProvider.ts",
        "    └── 2-5: PaymentProvider",
        "        interface PaymentProvider",
        "",
        "Files",
        "├── src/checkout/CheckoutService.ts",
        "└── src/payments/PaymentProvider.ts",
        "",
      ].join("\n"),
    );
  });

  it("renders empty sections under their headers when there are no matches", () => {
    const result: ResolveResult = {
      query: "Nope",
      fuzzy: false,
      symbols: [],
      files: [],
    };
    expect(renderResolveText(result)).toBe(
      ["Resolve: Nope", "", "Symbols", "(none)", "", "Files", "(none)", ""].join("\n"),
    );
  });

  it("renders only the Files section when no symbol matches", () => {
    const result: ResolveResult = {
      query: "Payment",
      fuzzy: true,
      symbols: [],
      files: ["src/Payment.ts"],
    };
    expect(renderResolveText(result)).toBe(
      ["Resolve: Payment", "", "Symbols", "(none)", "", "Files", "└── src/Payment.ts", ""].join(
        "\n",
      ),
    );
  });

  it("groups multiple symbols in the same file under one file branch", () => {
    const result: ResolveResult = {
      query: "charge",
      fuzzy: false,
      symbols: [
        decl({
          file: "src/payments/PaymentProcessor.ts",
          segments: [{ name: "PaymentProcessor" }, { name: "charge" }],
          kind: "method",
          startLine: 22,
          endLine: 36,
          signature: ["static async charge(order: Order): Promise<Payment>"],
        }),
        decl({
          file: "src/payments/PaymentProcessor.ts",
          segments: [{ name: "PaymentProcessor" }, { name: "refund" }],
          kind: "method",
          startLine: 40,
          endLine: 52,
          signature: ["static async refund(order: Order): Promise<Payment>"],
        }),
      ],
      files: [],
    };
    expect(renderResolveText(result)).toBe(
      [
        "Resolve: charge",
        "",
        "Symbols",
        "└── src/payments/PaymentProcessor.ts",
        "    ├── 22-36: PaymentProcessor::charge",
        "    │   static async charge(order: Order): Promise<Payment>",
        "    └── 40-52: PaymentProcessor::refund",
        "        static async refund(order: Order): Promise<Payment>",
        "",
        "Files",
        "(none)",
        "",
      ].join("\n"),
    );
  });
});
