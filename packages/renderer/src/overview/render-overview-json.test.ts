import { describe, expect, it } from "vitest";

import type { FileSymbols, SymbolDecl, SymbolKind } from "@symnav/core";

import { renderOverviewJson } from "./render-overview-json.js";

function decl(
  partial: Partial<Omit<SymbolDecl, "kind">> & Pick<SymbolDecl, "name"> & { kind: SymbolKind },
): SymbolDecl {
  return {
    range: { startLine: 1, endLine: 1 },
    signature: { startLine: 1, lines: [""] },
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
          kind: { role: "callable", nativeLabel: "function" },
          name: "leaf",
          range: { startLine: 4, endLine: 4 },
          signature: { startLine: 4, lines: ["function leaf(): void"] },
        }),
      ],
    };
    const parsed = JSON.parse(renderOverviewJson(file));
    expect(parsed).toEqual({
      filePath: "src/file.ts",
      symbols: [
        {
          kind: { role: "callable", nativeLabel: "function" },
          name: "leaf",
          range: { startLine: 4, endLine: 4 },
          signature: { startLine: 4, lines: ["function leaf(): void"] },
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
          kind: { role: "callable", nativeLabel: "function" },
          name: "leaf",
          signature: { startLine: 1, lines: ["function leaf(): void"] },
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

    const declKeyOrder = ["children", "kind", "name", "range", "signature"];
    const declKeyLines = lines
      .filter((line) => /^ {6}"[a-zA-Z]+":/.test(line))
      .map((line) => line.trim().split('"')[1]);
    expect(declKeyLines).toEqual(declKeyOrder);
  });

  it("emits the signature object with its startLine and lines", () => {
    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: { role: "callable", nativeLabel: "function" },
          name: "configure",
          range: { startLine: 10, endLine: 12 },
          signature: { startLine: 10, lines: ["function configure(", "  host: string,", "): void"] },
        }),
      ],
    };
    const parsed = JSON.parse(renderOverviewJson(file)) as FileSymbols;
    expect(parsed.symbols[0]?.signature).toEqual({
      startLine: 10,
      lines: ["function configure(", "  host: string,", "): void"],
    });
  });

  it("renders identical bytes for identical IR across two calls", () => {
    const build = (): FileSymbols => ({
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: { role: "container", nativeLabel: "class" },
          name: "C",
          range: { startLine: 1, endLine: 10 },
          signature: { startLine: 1, lines: ["class C"] },
          children: [
            decl({
              kind: { role: "callable", nativeLabel: "method" },
              name: "m",
              range: { startLine: 2, endLine: 4 },
              signature: { startLine: 2, lines: ["m(): void"] },
            }),
          ],
        }),
      ],
    });
    expect(renderOverviewJson(build())).toBe(renderOverviewJson(build()));
  });
});
