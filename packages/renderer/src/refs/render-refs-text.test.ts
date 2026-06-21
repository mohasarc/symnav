import { describe, expect, it } from "vitest";

import type { SymbolReference, ReferenceKind, RefsResult, SymbolIdentity } from "@symnav/core";

import { renderRefsText } from "./render-refs-text.js";

function reference(
  file: string,
  line: number,
  previewSource: string,
  kind: ReferenceKind,
): SymbolReference {
  const matchStart = previewSource.indexOf("PaymentProcessor");
  return {
    file,
    line,
    previewSource,
    matchStart,
    matchEnd: matchStart + "PaymentProcessor".length,
    kind,
  };
}

const identity: SymbolIdentity = {
  file: "src/payments/PaymentProcessor.ts",
  segments: [{ name: "PaymentProcessor" }],
};

describe("renderRefsText", () => {
  it("renders the spec example byte-exactly", () => {
    const references = [
      reference(
        "src/checkout/CheckoutService.ts",
        3,
        'import { PaymentProcessor } from "../payments/PaymentProcessor"',
        "import",
      ),
      reference(
        "src/checkout/CheckoutService.ts",
        44,
        "const receipt = await PaymentProcessor.charge(order)",
        "usage",
      ),
      reference(
        "src/payments/index.ts",
        2,
        'export { PaymentProcessor } from "./PaymentProcessor"',
        "export",
      ),
      reference(
        "src/payments/RefundService.ts",
        6,
        'import { PaymentProcessor } from "./PaymentProcessor"',
        "import",
      ),
      reference(
        "src/payments/RefundService.ts",
        29,
        "await PaymentProcessor.refund(paymentId)",
        "usage",
      ),
      reference(
        "src/tests/payments/PaymentProcessor.test.ts",
        18,
        "expect(await PaymentProcessor.charge(order)).toEqual(receipt)",
        "usage",
      ),
    ];
    const result: RefsResult = {
      identity,
      total: 6,
      kindCounts: { usage: 3, import: 2, export: 1, type: 0 },
      page: 1,
      pageCount: 1,
      fullLines: false,
      references,
    };
    expect(renderRefsText(result)).toBe(
      [
        "References: PaymentProcessor",
        "Total: 6",
        "Kinds: usage 3, import 2, export 1",
        "Page: 1/1",
        "Sort: path, line",
        "",
        "src/",
        "├── checkout/CheckoutService.ts",
        '│   ├── 3: import { PaymentProcessor } from "../payments/PaymentProcessor"  [import]',
        "│   └── 44: const receipt = await PaymentProcessor.charge(order)  [usage]",
        "├── payments/",
        "│   ├── index.ts",
        '│   │   └── 2: export { PaymentProcessor } from "./PaymentProcessor"  [export]',
        "│   └── RefundService.ts",
        '│       ├── 6: import { PaymentProcessor } from "./PaymentProcessor"  [import]',
        "│       └── 29: await PaymentProcessor.refund(paymentId)  [usage]",
        "└── tests/payments/PaymentProcessor.test.ts",
        "    └── 18: expect(await PaymentProcessor.charge(order)).toEqual(receipt)  [usage]",
        "",
      ].join("\n"),
    );
  });

  it("renders zero references as a header with no kinds line and no tree", () => {
    const result: RefsResult = {
      identity,
      total: 0,
      kindCounts: { usage: 0, import: 0, export: 0, type: 0 },
      page: 1,
      pageCount: 1,
      fullLines: false,
      references: [],
    };
    expect(renderRefsText(result)).toBe(
      ["References: PaymentProcessor", "Total: 0", "Page: 1/1", "Sort: path, line", ""].join("\n"),
    );
  });

  it("renders previews verbatim when the result requests full lines", () => {
    const indentedLine = `        const charge = PaymentProcessor.charge(${"order, ".repeat(20)}order)`;
    const references = [
      reference("src/x.ts", 5, indentedLine, "usage"),
      reference("tools/y.ts", 9, "  PaymentProcessor.refund(id)", "usage"),
    ];
    const result: RefsResult = {
      identity,
      total: 2,
      kindCounts: { usage: 2, import: 0, export: 0, type: 0 },
      page: 1,
      pageCount: 1,
      fullLines: true,
      references,
    };
    expect(renderRefsText(result)).toBe(
      [
        "References: PaymentProcessor",
        "Total: 2",
        "Kinds: usage 2",
        "Page: 1/1",
        "Sort: path, line",
        "",
        "src/x.ts",
        `└── 5: ${indentedLine}  [usage]`,
        "tools/y.ts",
        "└── 9:   PaymentProcessor.refund(id)  [usage]",
        "",
      ].join("\n"),
    );
  });
});
