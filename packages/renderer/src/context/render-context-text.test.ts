import { describe, expect, it } from "vitest";

import type {
  CallEdge,
  CallSite,
  ContextResult,
  HistoryEntry,
  ReferenceKind,
  SymbolDecl,
  SymbolPathSegment,
} from "@symnav/core";

import { renderContextText } from "./render-context-text.js";

interface DeclInput {
  readonly file: string;
  readonly segments: readonly SymbolPathSegment[];
  readonly nativeLabel: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly header: readonly string[];
}

function decl(input: DeclInput): SymbolDecl {
  return {
    type: "symbol",
    identity: { file: input.file, segments: input.segments },
    kind: { role: "callable", nativeLabel: input.nativeLabel },
    range: { startLine: input.startLine, endLine: input.endLine },
    header: { startLine: input.startLine, lines: input.header },
    children: [],
  };
}

function site(file: string, line: number, previewSource: string): CallSite {
  return { file, line, previewSource, matchStart: 0, matchEnd: 4 };
}

function edge(symbol: SymbolDecl, sites: readonly CallSite[]): CallEdge {
  return { symbol, sites, confidence: "certain" };
}

function emptyKindCounts(): Record<ReferenceKind, number> {
  return { usage: 0, import: 0, export: 0, type: 0 };
}

const target = decl({
  file: "src/checkout/CheckoutService.ts",
  segments: [{ name: "CheckoutService" }, { name: "processPayment" }],
  nativeLabel: "method-implementation",
  startLine: 42,
  endLine: 78,
  header: ["async processPayment(order: Order): Promise<Receipt>"],
});

function baseResult(overrides: Partial<ContextResult> = {}): ContextResult {
  return {
    identity: target.identity,
    target,
    definitions: [target],
    callers: { sortedEdges: [], omittedCertainEdgeCount: 0 },
    callees: { sortedEdges: [], omittedCertainEdgeCount: 0 },
    references: { total: 0, kindCounts: emptyKindCounts() },
    history: [],
    ...overrides,
  };
}

describe("renderContextText", () => {
  it("renders the full spec-shaped block", () => {
    const caller = decl({
      file: "src/api/CheckoutController.ts",
      segments: [{ name: "CheckoutController" }, { name: "submitOrder" }],
      nativeLabel: "method-implementation",
      startLine: 58,
      endLine: 72,
      header: ["async submitOrder(): Promise<void>"],
    });
    const charge = decl({
      file: "src/payments/PaymentProcessor.ts",
      segments: [{ name: "PaymentProcessor" }, { name: "charge" }],
      nativeLabel: "method-implementation",
      startLine: 22,
      endLine: 36,
      header: ["static async charge(order: Order): Promise<Payment>"],
    });
    const recordReceipt = decl({
      file: "src/payments/PaymentProcessor.ts",
      segments: [{ name: "PaymentProcessor" }, { name: "recordReceipt" }],
      nativeLabel: "method-implementation",
      startLine: 47,
      endLine: 55,
      header: ["static async recordReceipt(receipt: Receipt): Promise<void>"],
    });
    const history: HistoryEntry[] = [
      {
        shortSha: "abc123f",
        isoDate: "2026-04-12",
        author: "Alice",
        subject: "add retry handling to payment processing",
      },
      {
        shortSha: "def456a",
        isoDate: "2026-03-29",
        author: "Bob",
        subject: "move checkout flow into CheckoutService",
      },
    ];
    const result = baseResult({
      callers: {
        sortedEdges: [
          edge(caller, [
            site(
              "src/api/CheckoutController.ts",
              60,
              "return checkoutService.processPayment(order)",
            ),
          ]),
        ],
        omittedCertainEdgeCount: 0,
      },
      callees: {
        sortedEdges: [
          edge(charge, [site("src/payments/PaymentProcessor.ts", 30, "PaymentProcessor.charge")]),
          edge(recordReceipt, [
            site("src/payments/PaymentProcessor.ts", 50, "PaymentProcessor.recordReceipt"),
          ]),
        ],
        omittedCertainEdgeCount: 0,
      },
      references: { total: 8, kindCounts: { usage: 3, import: 2, export: 0, type: 3 } },
      history,
    });

    expect(renderContextText(result)).toBe(
      [
        "Context: CheckoutService::processPayment",
        "File: src/checkout/CheckoutService.ts",
        "Lines: 42-78",
        "",
        "Definition",
        "src/checkout/CheckoutService.ts",
        "└── 42-78: CheckoutService::processPayment  [implementation]",
        "    async processPayment(order: Order): Promise<Receipt>",
        "",
        "Callers",
        "src/api/CheckoutController.ts",
        "└── 58-72: CheckoutController::submitOrder  [call]",
        "    return checkoutService.processPayment(order)",
        "",
        "Callees",
        "src/payments/PaymentProcessor.ts",
        "├── 22-36: PaymentProcessor::charge  [call]",
        "│   static async charge(order: Order): Promise<Payment>",
        "└── 47-55: PaymentProcessor::recordReceipt  [call]",
        "    static async recordReceipt(receipt: Receipt): Promise<void>",
        "",
        "References",
        "Total: 8",
        "Kinds: usage 3, import 2, type 3",
        "Run: symnav refs src/checkout/CheckoutService.ts::CheckoutService::processPayment",
        "",
        "Recent History",
        "1. abc123f 2026-04-12 Alice",
        "   add retry handling to payment processing",
        "",
        "2. def456a 2026-03-29 Bob",
        "   move checkout flow into CheckoutService",
        "",
      ].join("\n"),
    );
  });

  it("tags a multi-site caller with [call xN] and previews the first site", () => {
    const caller = decl({
      file: "src/api/CheckoutController.ts",
      segments: [{ name: "CheckoutController" }, { name: "submitOrder" }],
      nativeLabel: "method-implementation",
      startLine: 58,
      endLine: 72,
      header: ["async submitOrder(): Promise<void>"],
    });
    const result = baseResult({
      callers: {
        sortedEdges: [
          edge(caller, [
            site("src/api/CheckoutController.ts", 60, "checkoutService.processPayment(order)"),
            site("src/api/CheckoutController.ts", 64, "checkoutService.processPayment(retry)"),
            site("src/api/CheckoutController.ts", 70, "checkoutService.processPayment(fallback)"),
          ]),
        ],
        omittedCertainEdgeCount: 0,
      },
    });
    const text = renderContextText(result);
    expect(text).toContain("└── 58-72: CheckoutController::submitOrder  [call ×3]");
    expect(text).toContain("    checkoutService.processPayment(order)");
    expect(text).not.toContain("checkoutService.processPayment(retry)");
  });

  it("points overflow callees and callers at graph", () => {
    const charge = decl({
      file: "src/payments/PaymentProcessor.ts",
      segments: [{ name: "PaymentProcessor" }, { name: "charge" }],
      nativeLabel: "method-implementation",
      startLine: 22,
      endLine: 36,
      header: ["static async charge(order: Order): Promise<Payment>"],
    });
    const caller = decl({
      file: "src/api/CheckoutController.ts",
      segments: [{ name: "CheckoutController" }, { name: "submitOrder" }],
      nativeLabel: "method-implementation",
      startLine: 58,
      endLine: 72,
      header: ["async submitOrder(): Promise<void>"],
    });
    const result = baseResult({
      callers: {
        sortedEdges: [edge(caller, [site("src/api/CheckoutController.ts", 60, "a()")])],
        omittedCertainEdgeCount: 3,
      },
      callees: {
        sortedEdges: [edge(charge, [site("src/payments/PaymentProcessor.ts", 30, "b()")])],
        omittedCertainEdgeCount: 5,
      },
    });
    const text = renderContextText(result);
    expect(text).toContain(
      "… 5 more callees. Run: symnav graph src/checkout/CheckoutService.ts::CheckoutService::processPayment --outgoing",
    );
    expect(text).toContain(
      "… 3 more callers. Run: symnav graph src/checkout/CheckoutService.ts::CheckoutService::processPayment --incoming",
    );
  });

  it("renders empty sections with (none)", () => {
    const result = baseResult();
    expect(renderContextText(result)).toBe(
      [
        "Context: CheckoutService::processPayment",
        "File: src/checkout/CheckoutService.ts",
        "Lines: 42-78",
        "",
        "Definition",
        "src/checkout/CheckoutService.ts",
        "└── 42-78: CheckoutService::processPayment  [implementation]",
        "    async processPayment(order: Order): Promise<Receipt>",
        "",
        "Callers",
        "(none)",
        "",
        "Callees",
        "(none)",
        "",
        "References",
        "(none)",
        "",
        "Recent History",
        "(none)",
        "",
      ].join("\n"),
    );
  });

  it("collapses single-child directories in multi-file callers", () => {
    const callerIn = (file: string, name: string) =>
      edge(
        decl({
          file,
          segments: [{ name }],
          nativeLabel: "function-implementation",
          startLine: 1,
          endLine: 3,
          header: [`function ${name}()`],
        }),
        [site(file, 2, `${name}()`)],
      );
    const result = baseResult({
      callers: {
        sortedEdges: [
          callerIn("src/checkout/CheckoutService.ts", "a"),
          callerIn("src/payments/index.ts", "b"),
          callerIn("src/payments/RefundService.ts", "c"),
          callerIn("src/tests/payments/PaymentProcessor.test.ts", "d"),
        ],
        omittedCertainEdgeCount: 0,
      },
    });
    const text = renderContextText(result);
    expect(text).toContain("src/");
    expect(text).toContain("├── checkout/CheckoutService.ts");
    expect(text).toContain("├── payments/");
    expect(text).toContain("└── tests/payments/PaymentProcessor.test.ts");
  });
});
