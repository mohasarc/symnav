import { describe, expect, it } from "vitest";

import type { RefsResult } from "@symnav/core";

import { renderRefsJson } from "./render-refs-json.js";

describe("renderRefsJson", () => {
  it("renders the result as pretty-printed JSON with a trailing newline", () => {
    const result: RefsResult = {
      identity: {
        file: "src/payments/PaymentProcessor.ts",
        segments: [{ name: "PaymentProcessor" }],
      },
      total: 1,
      kindCounts: { usage: 1, import: 0, export: 0, type: 0 },
      page: 1,
      pageCount: 1,
      fullLines: false,
      references: [
        {
          file: "src/checkout/CheckoutService.ts",
          line: 44,
          previewSource: "const receipt = await PaymentProcessor.charge(order)",
          matchStart: 22,
          matchEnd: 38,
          kind: "usage",
        },
      ],
    };
    const rendered = renderRefsJson(result);
    expect(rendered).toBe(JSON.stringify(result, null, 2) + "\n");
    expect(JSON.parse(rendered)).toEqual(result);
  });
});
