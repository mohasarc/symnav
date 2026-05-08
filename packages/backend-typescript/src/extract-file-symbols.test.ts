import { parseTs } from "@symnav/testing";
import { describe, expect, it } from "vitest";
import { extractFileSymbols } from "./extract.js";

describe("extractFileSymbols", () => {
  it("returns the supplied filePath verbatim on the IR", () => {
    const sourceFile = parseTs("export {};\n");
    const ir = extractFileSymbols({ sourceFile, filePath: "src/x.ts" });
    expect(ir.filePath).toBe("src/x.ts");
  });

  it("returns an empty symbols array for an empty source", () => {
    const sourceFile = parseTs("");
    const ir = extractFileSymbols({ sourceFile, filePath: "empty.ts" });
    expect(ir.symbols).toEqual([]);
  });

  it("preserves source order across siblings", () => {
    const sourceFile = parseTs(
      ["function a() {}", "class B {}", "interface C {}", "type D = number;", ""].join("\n"),
    );
    const ir = extractFileSymbols({ sourceFile, filePath: "x.ts" });
    expect(ir.symbols.map((s) => s.name)).toEqual(["a", "B", "C", "D"]);
    expect(ir.symbols.map((s) => s.kind)).toEqual(["function", "class", "interface", "type-alias"]);
  });

  it("emits class members as children", () => {
    const sourceFile = parseTs(
      [
        "class C {",
        "  prop = 1;",
        "  constructor() {}",
        "  method(): void {}",
        "  get value() { return 1; }",
        "  set value(v: number) {}",
        "}",
        "",
      ].join("\n"),
    );
    const ir = extractFileSymbols({ sourceFile, filePath: "x.ts" });
    expect(ir.symbols).toHaveLength(1);
    const cls = ir.symbols[0]!;
    expect(cls.kind).toBe("class");
    expect(cls.children.map((c) => c.kind)).toEqual([
      "property",
      "constructor",
      "method",
      "getter",
      "setter",
    ]);
  });

  it("emits interface members as children including index/call/construct signatures", () => {
    const sourceFile = parseTs(
      [
        "interface I {",
        "  prop: number;",
        "  method(): void;",
        "  (): number;",
        "  new (): I;",
        "  [key: string]: number;",
        "}",
        "",
      ].join("\n"),
    );
    const ir = extractFileSymbols({ sourceFile, filePath: "x.ts" });
    const iface = ir.symbols[0]!;
    expect(iface.children.map((c) => c.kind)).toEqual([
      "property",
      "method",
      "call-signature",
      "construct-signature",
      "index-signature",
    ]);
  });

  it("recursively walks namespace bodies", () => {
    const sourceFile = parseTs(
      [
        "namespace Outer {",
        "  export function inner() {}",
        "  export class Nested {",
        "    method() {}",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const ir = extractFileSymbols({ sourceFile, filePath: "x.ts" });
    const ns = ir.symbols[0]!;
    expect(ns.kind).toBe("namespace");
    expect(ns.children.map((c) => ({ kind: c.kind, name: c.name }))).toEqual([
      { kind: "function", name: "inner" },
      { kind: "class", name: "Nested" },
    ]);
    const nested = ns.children[1]!;
    expect(nested.children.map((c) => c.name)).toEqual(["method"]);
  });

  it("expands `const a = 1, b = 2` into two variable decls", () => {
    const sourceFile = parseTs("const a = 1, b = 2;\n");
    const ir = extractFileSymbols({ sourceFile, filePath: "x.ts" });
    expect(ir.symbols).toHaveLength(2);
    expect(ir.symbols.map((s) => ({ kind: s.kind, name: s.name }))).toEqual([
      { kind: "variable", name: "a" },
      { kind: "variable", name: "b" },
    ]);
  });

  it("emits a default-export decl named 'default'", () => {
    const sourceFile = parseTs("export default 42;\n");
    const ir = extractFileSymbols({ sourceFile, filePath: "x.ts" });
    expect(ir.symbols).toHaveLength(1);
    const decl = ir.symbols[0]!;
    expect(decl.kind).toBe("default-export");
    expect(decl.name).toBe("default");
  });

  it("skips re-export and bare-import statements", () => {
    const sourceFile = parseTs(
      ['export { foo } from "./x";', 'import "./side-effect";', "function keeper() {}", ""].join(
        "\n",
      ),
    );
    const ir = extractFileSymbols({ sourceFile, filePath: "x.ts" });
    expect(ir.symbols.map((s) => s.name)).toEqual(["keeper"]);
  });

  it("emits single-line and multi-line ranges correctly", () => {
    const sourceFile = parseTs(
      ["const single = 1;", "function multi() {", "  return 2;", "}", ""].join("\n"),
    );
    const ir = extractFileSymbols({ sourceFile, filePath: "x.ts" });
    expect(ir.symbols).toHaveLength(2);
    const single = ir.symbols[0]!;
    const multi = ir.symbols[1]!;
    expect(single.range).toEqual({ startLine: 1, endLine: 1 });
    expect(multi.range).toEqual({ startLine: 2, endLine: 4 });
  });

  it("renders an enum decl with no children", () => {
    const sourceFile = parseTs("enum Color { Red, Green }\n");
    const ir = extractFileSymbols({ sourceFile, filePath: "x.ts" });
    const e = ir.symbols[0]!;
    expect(e.kind).toBe("enum");
    expect(e.children).toEqual([]);
  });
});
