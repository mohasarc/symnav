import { describe, expect, it } from "vitest";

import type { DefinitionResult } from "@symnav/core";

import { renderDefinitionJson } from "./render-definition-json.js";

describe("renderDefinitionJson", () => {
  it("emits pretty-printed JSON over the DefinitionResult", () => {
    const result: DefinitionResult = {
      identity: { file: "src/http/Router.ts", segments: [{ name: "Router" }, { name: "post" }] },
      symbols: [
        {
          type: "symbol",
          identity: {
            file: "src/http/Router.ts",
            segments: [{ name: "Router" }, { name: "post", disambiguator: 1 }],
          },
          kind: { role: "callable", nativeLabel: "method-overload-signature" },
          range: { startLine: 4, endLine: 4 },
          header: { startLine: 4, lines: ["post(path: string, handler: Handler): void"] },
          children: [],
        },
      ],
    };
    const json = renderDefinitionJson(result);
    expect(json.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(json) as DefinitionResult;
    expect(parsed.identity).toEqual({
      file: "src/http/Router.ts",
      segments: [{ name: "Router" }, { name: "post" }],
    });
    expect(parsed.symbols).toHaveLength(1);
    const first = parsed.symbols[0]!;
    expect(first.identity.segments).toEqual([
      { name: "Router" },
      { name: "post", disambiguator: 1 },
    ]);
    expect(first.kind).toEqual({ role: "callable", nativeLabel: "method-overload-signature" });
    expect(first.range).toEqual({ startLine: 4, endLine: 4 });
  });

  it("preserves the result's own key order", () => {
    const result: DefinitionResult = {
      identity: { segments: [{ name: "X" }], file: "a.ts" },
      symbols: [],
    };
    const json = renderDefinitionJson(result);
    expect(json).toBe(
      [
        "{",
        '  "identity": {',
        '    "segments": [',
        "      {",
        '        "name": "X"',
        "      }",
        "    ],",
        '    "file": "a.ts"',
        "  },",
        '  "symbols": []',
        "}",
        "",
      ].join("\n"),
    );
  });
});
