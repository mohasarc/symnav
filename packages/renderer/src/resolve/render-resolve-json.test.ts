import { describe, expect, it } from "vitest";

import type { ResolveResult } from "@symnav/core";

import { renderResolveJson } from "./render-resolve-json.js";

describe("renderResolveJson", () => {
  it("emits a parseable JSON object with the canonical keys", () => {
    const result: ResolveResult = {
      query: "Payment",
      fuzzy: true,
      symbols: [
        {
          identity: { file: "src/payments/types.ts", segments: [{ name: "Payment" }] },
          kind: { role: "type", nativeLabel: "interface" },
          range: { startLine: 3, endLine: 6 },
          signature: { startLine: 3, lines: ["interface Payment"] },
          children: [],
        },
      ],
      files: ["src/Payment.ts"],
    };
    const json = renderResolveJson(result);
    expect(json.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(json) as ResolveResult;
    expect(parsed).toEqual(result);
  });

  it("emits stably-ordered keys", () => {
    const result: ResolveResult = {
      query: "x",
      fuzzy: false,
      symbols: [],
      files: [],
    };
    const json = renderResolveJson(result);
    expect(json).toBe(
      [
        "{",
        '  "files": [],',
        '  "fuzzy": false,',
        '  "query": "x",',
        '  "symbols": []',
        "}",
        "",
      ].join("\n"),
    );
  });
});
