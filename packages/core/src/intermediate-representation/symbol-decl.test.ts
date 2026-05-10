import { describe, expect, it } from "vitest";

import type { SymbolDecl } from "./types.js";

describe("SymbolDecl.signatureSource", () => {
  it("round-trips a raw multi-line source-text excerpt without truncation", () => {
    const rawSignature = "export function greet(\n  name: string,\n  greeting: string,\n): string";
    const decl: SymbolDecl = {
      kind: "function",
      name: "greet",
      range: { startLine: 1, endLine: 4 },
      signatureSource: rawSignature,
      children: [],
    };
    expect(decl.signatureSource).toBe(rawSignature);
    expect(decl.signatureSource).not.toContain("…");
    expect(decl.signatureSource).not.toContain("...");
  });
});
