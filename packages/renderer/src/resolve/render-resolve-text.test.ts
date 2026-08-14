import { describe, expect, it } from "vitest";

import type { ResolveResult, Header, SymbolOverviewNode, SymbolPathSegment } from "@symnav/core";

import { renderResolveText } from "./render-resolve-text.js";

interface DeclInput {
  readonly file: string;
  readonly segments: readonly SymbolPathSegment[];
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly header: readonly string[];
}

function decl(input: DeclInput): SymbolOverviewNode {
  const sig: Header = { startLine: input.startLine, lines: input.header };
  return {
    type: "symbol",
    identity: { file: input.file, segments: input.segments },
    kind: { role: "value", nativeLabel: input.kind },
    range: { startLine: input.startLine, endLine: input.endLine },
    header: sig,
    children: [],
  };
}

describe("renderResolveText", () => {
  it("renders the canonical multi-file Payment example", () => {
    const result: ResolveResult = {
      query: "Payment",
      mode: "fuzzy",
      symbols: [
        decl({
          file: "src/checkout/CheckoutService.ts",
          segments: [{ name: "MAX_PAYMENT_RETRIES" }],
          kind: "variable",
          startLine: 8,
          endLine: 8,
          header: ["const MAX_PAYMENT_RETRIES: number"],
        }),
        decl({
          file: "src/checkout/CheckoutService.ts",
          segments: [{ name: "CheckoutService" }, { name: "processPayment" }],
          kind: "method",
          startLine: 42,
          endLine: 78,
          header: ["async processPayment(order: Order): Promise<Receipt>"],
        }),
        decl({
          file: "src/payments/PaymentProvider.ts",
          segments: [{ name: "PaymentProvider" }],
          kind: "interface",
          startLine: 2,
          endLine: 5,
          header: ["interface PaymentProvider"],
        }),
      ],
      files: ["src/checkout/CheckoutService.ts", "src/payments/PaymentProvider.ts"],
    };
    const output = renderResolveText(result);
    expect(output).toBe(
      [
        "Resolve: Payment (fuzzy)",
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
      mode: "regex",
      symbols: [],
      files: [],
    };
    expect(renderResolveText(result)).toBe(
      ["Resolve: Nope (regex)", "", "Symbols", "(none)", "", "Files", "(none)", ""].join("\n"),
    );
  });

  it("guides broader matching after an empty exact result", () => {
    const result: ResolveResult = {
      query: "Nope",
      mode: "exact",
      symbols: [],
      files: [],
    };

    expect(renderResolveText(result)).toBe(
      [
        "Resolve: Nope (exact)",
        "",
        "Symbols",
        "(none)",
        "",
        "Files",
        "(none)",
        "",
        "No exact match; try --fuzzy for approximate names, or --regex for a pattern.",
        "",
      ].join("\n"),
    );
  });

  it.each([
    {
      name: "symbol-only exact",
      result: {
        query: "Payment",
        mode: "exact",
        symbols: [
          decl({
            file: "src/Payment.ts",
            segments: [{ name: "Payment" }],
            kind: "class",
            startLine: 1,
            endLine: 2,
            header: ["class Payment"],
          }),
        ],
        files: [],
      },
    },
    {
      name: "file-only exact",
      result: {
        query: "Payment",
        mode: "exact",
        symbols: [],
        files: ["src/Payment.ts"],
      },
    },
    {
      name: "empty fuzzy",
      result: { query: "Nope", mode: "fuzzy", symbols: [], files: [] },
    },
    {
      name: "empty regex",
      result: { query: "Nope", mode: "regex", symbols: [], files: [] },
    },
  ] satisfies readonly { readonly name: string; readonly result: ResolveResult }[])(
    "omits exact-empty guidance for $name results",
    ({ result }) => {
      expect(renderResolveText(result)).not.toContain("No exact match");
    },
  );

  it("renders only the Files section when no symbol matches", () => {
    const result: ResolveResult = {
      query: "Payment",
      mode: "fuzzy",
      symbols: [],
      files: ["src/Payment.ts"],
    };
    expect(renderResolveText(result)).toBe(
      [
        "Resolve: Payment (fuzzy)",
        "",
        "Symbols",
        "(none)",
        "",
        "Files",
        "└── src/Payment.ts",
        "",
      ].join("\n"),
    );
  });

  it("emits `name#N` segments for disambiguated overloads", () => {
    const result: ResolveResult = {
      query: "post",
      mode: "exact",
      symbols: [
        decl({
          file: "src/http/Router.ts",
          segments: [{ name: "Router" }, { name: "post", disambiguator: 1 }],
          kind: "method",
          startLine: 40,
          endLine: 40,
          header: ["post(path: string, handler: Handler): void"],
        }),
        decl({
          file: "src/http/Router.ts",
          segments: [{ name: "Router" }, { name: "post", disambiguator: 2 }],
          kind: "method",
          startLine: 44,
          endLine: 44,
          header: ["post(path: RegExp, handler: Handler): void"],
        }),
      ],
      files: [],
    };
    expect(renderResolveText(result)).toBe(
      [
        "Resolve: post (exact)",
        "",
        "Symbols",
        "└── src/http/Router.ts",
        "    ├── 40: Router::post#1",
        "    │   post(path: string, handler: Handler): void",
        "    └── 44: Router::post#2",
        "        post(path: RegExp, handler: Handler): void",
        "",
        "Files",
        "(none)",
        "",
      ].join("\n"),
    );
  });

  it("groups multiple symbols in the same file under one file branch", () => {
    const result: ResolveResult = {
      query: "charge",
      mode: "exact",
      symbols: [
        decl({
          file: "src/payments/PaymentProcessor.ts",
          segments: [{ name: "PaymentProcessor" }, { name: "charge" }],
          kind: "method",
          startLine: 22,
          endLine: 36,
          header: ["static async charge(order: Order): Promise<Payment>"],
        }),
        decl({
          file: "src/payments/PaymentProcessor.ts",
          segments: [{ name: "PaymentProcessor" }, { name: "refund" }],
          kind: "method",
          startLine: 40,
          endLine: 52,
          header: ["static async refund(order: Order): Promise<Payment>"],
        }),
      ],
      files: [],
    };
    expect(renderResolveText(result)).toBe(
      [
        "Resolve: charge (exact)",
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
