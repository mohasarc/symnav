import type { FileSymbols, SymbolDecl } from "@symnav/core";
import { describe, expect, it } from "vitest";
import { renderOverviewText } from "./overview.js";

function decl(partial: Partial<SymbolDecl> & Pick<SymbolDecl, "name">): SymbolDecl {
  return {
    kind: partial.kind ?? "function",
    name: partial.name,
    range: partial.range ?? { startLine: 1, endLine: 1 },
    signature: partial.signature ?? `function ${partial.name}()`,
    children: partial.children ?? [],
  };
}

function assertTrailingNewline(out: string): void {
  expect(out.endsWith("\n")).toBe(true);
  // Exactly one trailing newline.
  expect(out.endsWith("\n\n")).toBe(false);
}

describe("renderOverviewText", () => {
  it("renders an empty file as header + blank line + (no symbols) + trailing newline", () => {
    const file: FileSymbols = { filePath: "src/empty.ts", symbols: [] };
    const out = renderOverviewText(file);
    expect(out).toBe("Overview: src/empty.ts\n\n(no symbols)\n");
    assertTrailingNewline(out);
  });

  it("renders a single top-level function flat with 3-space-indented signature", () => {
    const file: FileSymbols = {
      filePath: "src/x.ts",
      symbols: [
        decl({
          name: "greet",
          range: { startLine: 4, endLine: 6 },
          signature: "function greet(name: string): string",
        }),
      ],
    };
    const out = renderOverviewText(file);
    expect(out).toMatchInlineSnapshot(`
      "Overview: src/x.ts

      4-6: greet
         function greet(name: string): string
      "
    `);
    assertTrailingNewline(out);
  });
});
