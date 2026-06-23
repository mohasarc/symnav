import { describe, expect, it } from "vitest";

import { countReferenceKinds } from "./reference-kinds.js";
import type { SymbolReference } from "./references.js";

function reference(overrides: Partial<SymbolReference>): SymbolReference {
  return {
    file: "src/a.ts",
    line: 1,
    previewSource: "PaymentProcessor",
    matchStart: 0,
    matchEnd: 16,
    kind: "usage",
    ...overrides,
  };
}

describe("countReferenceKinds", () => {
  it("counts each kind across the set", () => {
    const references = [
      reference({ kind: "usage" }),
      reference({ kind: "usage" }),
      reference({ kind: "import" }),
      reference({ kind: "export" }),
      reference({ kind: "type" }),
      reference({ kind: "type" }),
      reference({ kind: "type" }),
    ];
    expect(countReferenceKinds(references)).toEqual({ usage: 2, import: 1, export: 1, type: 3 });
  });

  it("reports zero for absent kinds", () => {
    expect(countReferenceKinds([])).toEqual({ usage: 0, import: 0, export: 0, type: 0 });
  });
});
