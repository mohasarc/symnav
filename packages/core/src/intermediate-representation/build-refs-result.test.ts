import { describe, expect, it } from "vitest";

import { buildRefsResult } from "./build-refs-result.js";
import type { SymbolReference } from "./references.js";
import type { SymbolIdentity } from "./symbol-identity.js";

const identity: SymbolIdentity = {
  file: "src/payments/PaymentProcessor.ts",
  segments: [{ name: "PaymentProcessor" }],
};

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

describe("buildRefsResult", () => {
  it("sorts references by file, then line, then matchStart", () => {
    const unsorted = [
      reference({ file: "src/b.ts", line: 2 }),
      reference({ file: "src/a.ts", line: 9, matchStart: 12, matchEnd: 28 }),
      reference({ file: "src/a.ts", line: 9, matchStart: 4, matchEnd: 20 }),
      reference({ file: "src/a.ts", line: 3 }),
    ];
    const result = buildRefsResult({
      identity,
      references: unsorted,
      pageRequest: { all: false },
      fullLines: false,
    });
    expect(
      result.references.map(({ file, line, matchStart }) => ({ file, line, matchStart })),
    ).toEqual([
      { file: "src/a.ts", line: 3, matchStart: 0 },
      { file: "src/a.ts", line: 9, matchStart: 4 },
      { file: "src/a.ts", line: 9, matchStart: 12 },
      { file: "src/b.ts", line: 2, matchStart: 0 },
    ]);
  });

  it("counts kinds across the full set with zeros for absent kinds", () => {
    const references = [
      reference({ kind: "usage", line: 1 }),
      reference({ kind: "usage", line: 2 }),
      reference({ kind: "import", line: 3 }),
      reference({ kind: "export", line: 4 }),
    ];
    const result = buildRefsResult({
      identity,
      references,
      pageRequest: { page: 2, pageSize: 3, all: false },
      fullLines: false,
    });
    expect(result.kindCounts).toEqual({ usage: 2, import: 1, export: 1, type: 0 });
  });

  it("paginates the sorted references and reports the full total", () => {
    const references = [7, 3, 5, 1, 6, 2, 4].map((line) => reference({ line }));
    const result = buildRefsResult({
      identity,
      references,
      pageRequest: { page: 2, pageSize: 3, all: false },
      fullLines: false,
    });
    expect(result.references.map(({ line }) => line)).toEqual([4, 5, 6]);
    expect(result.total).toBe(7);
    expect(result.page).toBe(2);
    expect(result.pageCount).toBe(3);
  });

  it.each([true, false])("threads fullLines %s onto the result", (fullLines) => {
    const result = buildRefsResult({
      identity,
      references: [],
      pageRequest: { all: false },
      fullLines,
    });
    expect(result.fullLines).toBe(fullLines);
  });
});
