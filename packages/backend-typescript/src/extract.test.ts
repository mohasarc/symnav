import { describe, expect, it } from "vitest";
import { parseTs } from "@symnav/testing";
import { extractFileSymbols, nodeKind } from "./extract.js";

function extract(source: string) {
  return extractFileSymbols({
    sourceFile: parseTs(source),
    filePath: "test.ts",
  }).symbols;
}

describe("extractFileSymbols — top-level functions", () => {
  it("extracts a top-level function with declaration-text-minus-body signature", () => {
    const [decl] = extract("export function greet(name: string): string { return name; }");
    expect(decl?.kind).toBe("function");
    expect(decl?.name).toBe("greet");
    expect(decl?.signature).toBe("export function greet(name: string): string");
    expect(decl?.range.startLine).toBe(1);
    expect(decl?.range.endLine).toBe(1);
  });

  it("handles async, generic, generator, and optional-parameter functions", () => {
    const decls = extract(`
async function a(): Promise<void> { return; }
function b<T>(x: T): T { return x; }
function* c(): Generator<number> { yield 1; }
function d(x?: number): number { return x ?? 0; }
`);
    expect(decls.map((d) => d.kind)).toEqual(["function", "function", "function", "function"]);
    expect(decls[0]?.signature).toBe("async function a(): Promise<void>");
    expect(decls[1]?.signature).toBe("function b<T>(x: T): T");
    expect(decls[2]?.signature).toBe("function* c(): Generator<number>");
    expect(decls[3]?.signature).toBe("function d(x?: number): number");
  });

  it("emits one decl per overload signature", () => {
    const decls = extract(`
function f(x: string): string;
function f(x: number): number;
function f(x: string | number): string | number { return x; }
`);
    expect(decls).toHaveLength(3);
    expect(decls.every((d) => d.name === "f" && d.kind === "function")).toBe(true);
  });
});

describe("extractFileSymbols — classes", () => {
  it("extracts a class with constructor, methods, getter/setter, property", () => {
    const decls = extract(`
class Box {
  value: number = 0;
  constructor(v: number) { this.value = v; }
  get current(): number { return this.value; }
  set current(v: number) { this.value = v; }
  describe(): string { return ""; }
  static make(): Box { return new Box(0); }
}
`);
    expect(decls).toHaveLength(1);
    const box = decls[0]!;
    expect(box.kind).toBe("class");
    expect(box.name).toBe("Box");
    const childKinds = box.children.map((c) => c.kind);
    expect(childKinds).toEqual(["property", "constructor", "getter", "setter", "method", "method"]);
    expect(box.signature).toBe("class Box");
  });
});

describe("extractFileSymbols — interfaces", () => {
  it("extracts properties, methods, index/call/construct signatures", () => {
    const decls = extract(`
interface Shape {
  name: string;
  area(): number;
  [key: string]: unknown;
  (): Shape;
  new (): Shape;
}
`);
    const shape = decls[0]!;
    expect(shape.kind).toBe("interface");
    const childKinds = shape.children.map((c) => c.kind);
    expect(childKinds).toEqual([
      "property",
      "method",
      "index-signature",
      "call-signature",
      "construct-signature",
    ]);
  });
});

describe("extractFileSymbols — types, enums, namespaces", () => {
  it("extracts a type alias with capped signature", () => {
    const long = "a".repeat(200);
    const [decl] = extract(`type Big = "${long}";`);
    expect(decl?.kind).toBe("type-alias");
    expect(decl?.signature.length).toBeLessThanOrEqual(120);
    expect(decl?.signature.endsWith("…")).toBe(true);
  });

  it("extracts an enum", () => {
    const [decl] = extract("enum Color { Red, Green, Blue }");
    expect(decl?.kind).toBe("enum");
    expect(decl?.name).toBe("Color");
    expect(decl?.signature).toBe("enum Color");
  });

  it("extracts a namespace with nested function as a child", () => {
    const decls = extract(`
namespace Outer {
  export function inner(): void {}
}
`);
    const outer = decls[0]!;
    expect(outer.kind).toBe("namespace");
    expect(outer.children).toHaveLength(1);
    expect(outer.children[0]?.kind).toBe("function");
    expect(outer.children[0]?.name).toBe("inner");
  });
});

describe("extractFileSymbols — variables", () => {
  it("annotated const renders 'const X: T'", () => {
    const [decl] = extract("const x: number = 42;");
    expect(decl?.kind).toBe("variable");
    expect(decl?.signature).toBe("const x: number");
  });

  it("unannotated const renders 'const X = <literal>'", () => {
    const [decl] = extract('const greeting = "hello";');
    expect(decl?.kind).toBe("variable");
    expect(decl?.signature).toBe('const greeting = "hello"');
  });

  it("long initializer is ellipsized", () => {
    const long = "a".repeat(200);
    const [decl] = extract(`const big = "${long}";`);
    expect(decl?.signature.length).toBeLessThanOrEqual(120);
    expect(decl?.signature.endsWith("…")).toBe(true);
  });

  it("a single statement with multiple declarators yields multiple decls", () => {
    const decls = extract("const a = 1, b = 2;");
    expect(decls).toHaveLength(2);
    expect(decls[0]?.name).toBe("a");
    expect(decls[1]?.name).toBe("b");
  });
});

describe("extractFileSymbols — default exports and skipped statements", () => {
  it("export default <expr> produces a default-export decl named 'default'", () => {
    const [decl] = extract("export default 42;");
    expect(decl?.kind).toBe("default-export");
    expect(decl?.name).toBe("default");
  });

  it("re-exports and bare imports produce no decls", () => {
    const decls = extract(`
export { foo } from "./x";
import "./side-effect";
`);
    expect(decls).toEqual([]);
  });
});

describe("extractFileSymbols — shape and ordering", () => {
  it("empty source produces empty symbols", () => {
    const decls = extract("");
    expect(decls).toEqual([]);
  });

  it("preserves source order across siblings", () => {
    const decls = extract(`
function a() {}
function b() {}
function c() {}
`);
    expect(decls.map((d) => d.name)).toEqual(["a", "b", "c"]);
  });

  it("reports single-line and multi-line ranges", () => {
    const decls = extract(`function single(): void {}
function multi(
  x: number,
): void {
  return;
}
`);
    expect(decls[0]?.range).toEqual({ startLine: 1, endLine: 1 });
    expect(decls[1]?.range.startLine).toBe(2);
    expect(decls[1]?.range.endLine).toBeGreaterThan(2);
  });

  it("returns the supplied filePath verbatim", () => {
    const file = extractFileSymbols({
      sourceFile: parseTs("export const x = 1;"),
      filePath: "src/sub/x.ts",
    });
    expect(file.filePath).toBe("src/sub/x.ts");
  });
});

describe("nodeKind classifier", () => {
  it("maps each top-level form to a SymbolKind", () => {
    const sf = parseTs(`
function f() {}
class C {}
interface I {}
type T = number;
enum E {}
namespace N {}
`);
    const stmts = sf.getStatements();
    expect(nodeKind(stmts[0]!)).toBe("function");
    expect(nodeKind(stmts[1]!)).toBe("class");
    expect(nodeKind(stmts[2]!)).toBe("interface");
    expect(nodeKind(stmts[3]!)).toBe("type-alias");
    expect(nodeKind(stmts[4]!)).toBe("enum");
    expect(nodeKind(stmts[5]!)).toBe("namespace");
  });
});
