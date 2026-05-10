import { describe, expect, it } from "vitest";

import type { FileSymbols, SymbolDecl } from "@symnav/core";

import { renderOverviewText } from "./render-overview-text.js";
import { SIGNATURE_CAP_CHARS, SIGNATURE_ELLIPSIS } from "./signature-cap.js";

function decl(partial: Partial<SymbolDecl> & Pick<SymbolDecl, "name" | "kind">): SymbolDecl {
  return {
    range: { startLine: 1, endLine: 1 },
    signatureSource: "",
    children: [],
    ...partial,
  };
}

function assertSingleTrailingNewline(output: string): void {
  expect(output.endsWith("\n")).toBe(true);
  expect(output.endsWith("\n\n")).toBe(false);
}

describe("renderOverviewText", () => {
  it("renders an empty file with header, blank line, and `(no symbols)`", () => {
    const file: FileSymbols = { filePath: "src/empty.ts", symbols: [] };
    const output = renderOverviewText(file);
    expect(output).toBe("Overview: src/empty.ts\n\n(no symbols)\n");
    assertSingleTrailingNewline(output);
  });

  it("renders a single top-level function flat with a 3-space signature indent", () => {
    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "function",
          name: "greet",
          range: { startLine: 4, endLine: 4 },
          signatureSource: "function greet(name: string): void",
        }),
      ],
    };
    const output = renderOverviewText(file);
    expect(output).toBe(
      "Overview: src/file.ts\n\n4: greet\n   function greet(name: string): void\n",
    );
    assertSingleTrailingNewline(output);
  });

  it("ends with exactly one trailing newline for non-empty output", () => {
    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "function",
          name: "greet",
          range: { startLine: 4, endLine: 4 },
          signatureSource: "function greet(): void",
        }),
      ],
    };
    assertSingleTrailingNewline(renderOverviewText(file));
  });

  it("emits a signatureSource shorter than SIGNATURE_CAP_CHARS verbatim", () => {
    const signature = "function greet(name: string): void";
    expect(signature.length).toBeLessThan(SIGNATURE_CAP_CHARS);

    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "function",
          name: "greet",
          range: { startLine: 1, endLine: 1 },
          signatureSource: signature,
        }),
      ],
    };
    expect(renderOverviewText(file)).toContain(`   ${signature}\n`);
  });

  it("truncates a signatureSource longer than SIGNATURE_CAP_CHARS to the cap and appends SIGNATURE_ELLIPSIS", () => {
    const oversized = "x".repeat(SIGNATURE_CAP_CHARS + 50);
    const file: FileSymbols = {
      filePath: "src/file.ts",
      symbols: [
        decl({
          kind: "function",
          name: "wide",
          range: { startLine: 1, endLine: 1 },
          signatureSource: oversized,
        }),
      ],
    };

    const output = renderOverviewText(file);
    const expectedHead = oversized.slice(0, SIGNATURE_CAP_CHARS - SIGNATURE_ELLIPSIS.length);
    expect(output).toContain(`   ${expectedHead}${SIGNATURE_ELLIPSIS}\n`);
    expect(output).not.toContain(oversized);
  });
});
