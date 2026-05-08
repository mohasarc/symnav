import { describe, expect, it } from "vitest";
import type { FileSymbols, SymbolDecl } from "@symnav/core";
import { renderOverviewJson, renderOverviewText } from "./overview.js";

function decl(
  name: string,
  kind: SymbolDecl["kind"],
  startLine: number,
  endLine: number,
  signature: string,
  children: readonly SymbolDecl[] = [],
): SymbolDecl {
  return {
    kind,
    name,
    range: { startLine, endLine },
    signature,
    children,
  };
}

function file(filePath: string, symbols: readonly SymbolDecl[]): FileSymbols {
  return { filePath, symbols };
}

function assertTrailingNewline(text: string): void {
  expect(text.endsWith("\n")).toBe(true);
  expect(text.endsWith("\n\n")).toBe(false);
}

describe("renderOverviewText", () => {
  it("empty file renders header + (no symbols) + trailing newline", () => {
    const out = renderOverviewText(file("empty.ts", []));
    expect(out).toBe("Overview: empty.ts\n\n(no symbols)\n");
    assertTrailingNewline(out);
  });

  it("single top-level function renders flat with 3-space signature indent", () => {
    const out = renderOverviewText(
      file("x.ts", [decl("greet", "function", 1, 3, "function greet(): void")]),
    );
    expect(out).toMatchInlineSnapshot(`
      "Overview: x.ts

      1-3: greet
         function greet(): void
      "
    `);
    assertTrailingNewline(out);
  });

  it("multiple top-level entries are separated by blank lines", () => {
    const out = renderOverviewText(
      file("multi.ts", [
        decl("a", "function", 1, 1, "function a(): void"),
        decl("b", "function", 3, 3, "function b(): void"),
        decl("c", "function", 5, 5, "function c(): void"),
      ]),
    );
    const blanks = (out.match(/\n\n/g) ?? []).length;
    // header blank + 2 separators = 3
    expect(blanks).toBe(3);
    assertTrailingNewline(out);
  });

  it("class with three methods uses ├── / └── correctly", () => {
    const klass = decl("Klass", "class", 1, 20, "class Klass", [
      decl("a", "method", 2, 4, "a(): void"),
      decl("b", "method", 6, 8, "b(): void"),
      decl("c", "method", 10, 12, "c(): void"),
    ]);
    const out = renderOverviewText(file("k.ts", [klass]));
    expect(out).toMatchInlineSnapshot(`
      "Overview: k.ts

      1-20: Klass
         class Klass
      ├── 2-4: Klass::a
      │   a(): void
      ├── 6-8: Klass::b
      │   b(): void
      └── 10-12: Klass::c
          c(): void
      "
    `);
    assertTrailingNewline(out);
  });

  it("three-deep nesting (namespace → class → method) indents correctly", () => {
    const inner = decl("Inner", "class", 2, 6, "class Inner", [
      decl("m", "method", 3, 5, "m(): void"),
    ]);
    const outer = decl("Outer", "namespace", 1, 7, "namespace Outer", [inner]);
    const out = renderOverviewText(file("n.ts", [outer]));
    expect(out).toMatchInlineSnapshot(`
      "Overview: n.ts

      1-7: Outer
         namespace Outer
      └── 2-6: Outer::Inner
          class Inner
          └── 3-5: Outer::Inner::m
              m(): void
      "
    `);
    assertTrailingNewline(out);
  });

  it("single-line range renders as N, multi-line as N-M", () => {
    const out = renderOverviewText(
      file("r.ts", [
        decl("a", "function", 8, 8, "function a(): void"),
        decl("b", "function", 12, 96, "function b(): void"),
      ]),
    );
    expect(out).toContain("8: a");
    expect(out).toContain("12-96: b");
  });

  it("symbol path includes ancestors joined by ::", () => {
    const klass = decl("Box", "class", 1, 5, "class Box", [
      decl("greet", "method", 2, 4, "greet(): void"),
    ]);
    const out = renderOverviewText(file("p.ts", [klass]));
    expect(out).toContain("Box::greet");
  });
});

describe("renderOverviewJson", () => {
  function sample(): FileSymbols {
    return file("x.ts", [
      decl("Box", "class", 1, 5, "class Box", [decl("greet", "method", 2, 4, "greet(): void")]),
    ]);
  }

  it("mirrors FileSymbols verbatim with children always present", () => {
    const out = renderOverviewJson(sample());
    const parsed = JSON.parse(out) as FileSymbols;
    expect(parsed.filePath).toBe("x.ts");
    expect(parsed.symbols[0]?.name).toBe("Box");
    expect(parsed.symbols[0]?.children[0]?.name).toBe("greet");
    expect(parsed.symbols[0]?.children[0]?.children).toEqual([]);
  });

  it("uses 2-space indent and sorted keys with trailing newline", () => {
    const out = renderOverviewJson(sample());
    expect(out.endsWith("\n")).toBe(true);
    expect(out.includes("  ")).toBe(true);
    const firstObjectLine = out.split("\n").find((l) => l.trim().startsWith('"'));
    // First key in sorted order at top level is "filePath"
    expect(firstObjectLine?.includes('"filePath"')).toBe(true);
  });

  it("renders identical bytes for identical IR across two calls", () => {
    const a = renderOverviewJson(sample());
    const b = renderOverviewJson(sample());
    expect(a).toBe(b);
  });
});
