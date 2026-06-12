import { describe, expect, it } from "vitest";

import type { Reference, ReferenceKind } from "@symnav/core";

import { buildReferenceTree } from "./reference-tree.js";

function reference(file: string, line: number, kind: ReferenceKind = "usage"): Reference {
  return {
    file,
    line,
    previewSource: `line ${line} of ${file}`,
    matchStart: 0,
    matchEnd: 4,
    kind,
  };
}

describe("buildReferenceTree", () => {
  it("collapses the whole directory chain into one root label when all references share a file", () => {
    const refs = [
      reference("src/payments/RefundService.ts", 6),
      reference("src/payments/RefundService.ts", 29),
    ];
    expect(buildReferenceTree(refs)).toEqual([
      { label: "src/payments/RefundService.ts", references: refs },
    ]);
  });

  it("keeps a file node and its line entries as separate levels for a single reference", () => {
    const refs = [reference("src/a.ts", 7)];
    expect(buildReferenceTree(refs)).toEqual([{ label: "src/a.ts", references: refs }]);
  });

  it("renders files under different top-level directories as top-level siblings", () => {
    const refs = [reference("src/a.ts", 1), reference("tools/b.ts", 2)];
    expect(buildReferenceTree(refs)).toEqual([
      { label: "src/a.ts", references: [refs[0]] },
      { label: "tools/b.ts", references: [refs[1]] },
    ]);
  });

  it("reproduces the spec example tree shape", () => {
    const checkoutImport = reference("src/checkout/CheckoutService.ts", 3, "import");
    const checkoutUsage = reference("src/checkout/CheckoutService.ts", 44, "usage");
    const indexExport = reference("src/payments/index.ts", 2, "export");
    const refundImport = reference("src/payments/RefundService.ts", 6, "import");
    const refundUsage = reference("src/payments/RefundService.ts", 29, "usage");
    const testUsage = reference("src/tests/payments/PaymentProcessor.test.ts", 18, "usage");
    const refs = [checkoutImport, checkoutUsage, indexExport, refundImport, refundUsage, testUsage];
    expect(buildReferenceTree(refs)).toEqual([
      {
        label: "src/",
        children: [
          {
            label: "checkout/CheckoutService.ts",
            references: [checkoutImport, checkoutUsage],
          },
          {
            label: "payments/",
            children: [
              { label: "index.ts", references: [indexExport] },
              { label: "RefundService.ts", references: [refundImport, refundUsage] },
            ],
          },
          {
            label: "tests/payments/PaymentProcessor.test.ts",
            references: [testUsage],
          },
        ],
      },
    ]);
  });
});
