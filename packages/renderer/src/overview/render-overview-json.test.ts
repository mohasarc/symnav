import { describe, expect, it } from "vitest";

import type { FileSymbols, SymbolDecl } from "@symnav/core";

import { renderOverviewJson } from "./render-overview-json.js";
import { SIGNATURE_CAP_CHARS } from "./signature-cap.js";

function decl(partial: Partial<SymbolDecl> & Pick<SymbolDecl, "name" | "kind">): SymbolDecl {
  return {
    range: { startLine: 1, endLine: 1 },
    signatureSource: "",
    children: [],
    ...partial,
  };
}

describe("renderOverviewJson", () => {
  it("mirrors FileSymbols verbatim with `children` always present on leaf decls", () => {
    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "function",
          name: "leaf",
          range: { startLine: 4, endLine: 4 },
          signatureSource: "function leaf(): void",
        }),
      ],
    };
    const parsed = JSON.parse(renderOverviewJson(file));
    expect(parsed).toEqual({
      filePath: "src/file.ts",
      symbols: [
        {
          kind: "function",
          name: "leaf",
          range: { startLine: 4, endLine: 4 },
          signatureSource: "function leaf(): void",
          children: [],
        },
      ],
    });
  });

  it("emits 2-space-indented output with sorted keys and a trailing newline", () => {
    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "function",
          name: "leaf",
          signatureSource: "function leaf(): void",
        }),
      ],
    };
    const output = renderOverviewJson(file);
    expect(output.endsWith("\n")).toBe(true);
    expect(output.endsWith("\n\n")).toBe(false);

    const lines = output.split("\n");
    expect(lines[0]).toBe("{");
    expect(lines[1]).toBe(`  "filePath": "src/file.ts",`);
    expect(lines[2]).toBe(`  "symbols": [`);

    const declKeyOrder = ["children", "kind", "name", "range", "signatureSource"];
    const declKeyLines = lines
      .filter((line) => /^ {6}"[a-zA-Z]+":/.test(line))
      .map((line) => line.trim().split('"')[1]);
    expect(declKeyLines).toEqual(declKeyOrder);
  });

  it("emits signatureSource uncapped even when the source exceeds SIGNATURE_CAP_CHARS", () => {
    const oversized = "x".repeat(SIGNATURE_CAP_CHARS + 50);
    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "function",
          name: "wide",
          signatureSource: oversized,
        }),
      ],
    };
    const output = renderOverviewJson(file);
    expect(output).toContain(oversized);
    expect(output).not.toContain("…");
  });

  it("renders identical bytes for identical IR across two calls", () => {
    const build = (): FileSymbols => ({
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "class",
          name: "C",
          range: { startLine: 1, endLine: 10 },
          signatureSource: "class C",
          children: [
            decl({
              kind: "method",
              name: "m",
              range: { startLine: 2, endLine: 4 },
              signatureSource: "m(): void",
            }),
          ],
        }),
      ],
    });
    expect(renderOverviewJson(build())).toBe(renderOverviewJson(build()));
  });
});
