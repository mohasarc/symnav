import { parseTs } from "@symnav/testing";
import { describe, expect, it } from "vitest";
import { renderSignature } from "./extract.js";
import { SIGNATURE_CAP_CHARS, SIGNATURE_ELLIPSIS } from "./signature-cap.js";

function firstStatement(source: string) {
  const stmt = parseTs(source).getStatements()[0];
  if (!stmt) throw new Error("expected at least one statement");
  return stmt;
}

describe("renderSignature: top-level functions", () => {
  it("renders a function declaration with declaration text up to (not including) the body", () => {
    const node = firstStatement("export function greet(name: string): string { return name; }\n");
    expect(renderSignature(node)).toBe("export function greet(name: string): string");
  });

  it("renders an async function", () => {
    const node = firstStatement("async function load(): Promise<void> {}\n");
    expect(renderSignature(node)).toBe("async function load(): Promise<void>");
  });

  it("renders a generator function", () => {
    const node = firstStatement("function* gen(): Iterable<number> {}\n");
    expect(renderSignature(node)).toBe("function* gen(): Iterable<number>");
  });

  it("renders a generic function", () => {
    const node = firstStatement(
      "function map<T, U>(t: T, f: (t: T) => U): U {\n  return f(t);\n}\n",
    );
    expect(renderSignature(node)).toBe("function map<T, U>(t: T, f: (t: T) => U): U");
  });

  it("renders an overload signature with no body, dropping the trailing semicolon", () => {
    const sourceFile = parseTs(
      [
        "function over(x: number): number;",
        "function over(x: string): string;",
        "function over(x: number | string): number | string { return x; }",
        "",
      ].join("\n"),
    );
    const stmts = sourceFile.getStatements();
    expect(renderSignature(stmts[0]!)).toBe("function over(x: number): number");
    expect(renderSignature(stmts[1]!)).toBe("function over(x: string): string");
    expect(renderSignature(stmts[2]!)).toBe("function over(x: number | string): number | string");
  });
});

describe("renderSignature: classes / interfaces / enums / namespaces", () => {
  it("renders a class declaration up to the opening brace", () => {
    const node = firstStatement("export class C extends B implements I {\n  a = 1;\n}\n");
    expect(renderSignature(node)).toBe("export class C extends B implements I");
  });

  it("renders an abstract class with modifiers preserved", () => {
    const node = firstStatement("abstract class Base<T> {\n  abstract run(): T;\n}\n");
    expect(renderSignature(node)).toBe("abstract class Base<T>");
  });

  it("renders an interface declaration up to the opening brace", () => {
    const node = firstStatement("interface I extends B {\n  x: number;\n}\n");
    expect(renderSignature(node)).toBe("interface I extends B");
  });

  it("renders an enum declaration up to the opening brace", () => {
    const node = firstStatement("enum Color {\n  Red,\n  Green,\n}\n");
    expect(renderSignature(node)).toBe("enum Color");
  });

  it("renders a namespace declaration up to the opening brace", () => {
    const node = firstStatement("namespace Outer {\n  export const x = 1;\n}\n");
    expect(renderSignature(node)).toBe("namespace Outer");
  });
});

describe("renderSignature: type aliases", () => {
  it("renders a short type alias verbatim including the leading 'type'", () => {
    const node = firstStatement("type T = number;\n");
    expect(renderSignature(node)).toBe("type T = number");
  });

  it("ellipsizes a long type alias at the cap", () => {
    const longUnion = Array.from({ length: 40 }, (_, i) => `'opt${i}'`).join(" | ");
    const source = `type Big = ${longUnion};\n`;
    const node = firstStatement(source);
    const rendered = renderSignature(node);
    expect(rendered.length).toBeLessThanOrEqual(SIGNATURE_CAP_CHARS);
    expect(rendered.endsWith(SIGNATURE_ELLIPSIS)).toBe(true);
    expect(rendered.startsWith("type Big = ")).toBe(true);
  });
});

describe("renderSignature: variables", () => {
  it("renders an annotated const using only the annotation", () => {
    const sourceFile = parseTs("const x: number = 1 + 2 + 3;\n");
    const decl = sourceFile.getVariableDeclarations()[0]!;
    expect(renderSignature(decl)).toBe("const x: number");
  });

  it("renders an unannotated const using the initializer", () => {
    const sourceFile = parseTs("const x = 42;\n");
    const decl = sourceFile.getVariableDeclarations()[0]!;
    expect(renderSignature(decl)).toBe("const x = 42");
  });

  it("renders let and var with the matching keyword", () => {
    const letDecl = parseTs("let y: string;\n").getVariableDeclarations()[0]!;
    const varDecl = parseTs("var z = true;\n").getVariableDeclarations()[0]!;
    expect(renderSignature(letDecl)).toBe("let y: string");
    expect(renderSignature(varDecl)).toBe("var z = true");
  });

  it("ellipsizes a long unannotated initializer at the cap", () => {
    const source = `const big = ${'"x".repeat(1)+'.repeat(40)}\"end\";\n`;
    const decl = parseTs(source).getVariableDeclarations()[0]!;
    const rendered = renderSignature(decl);
    expect(rendered.length).toBeLessThanOrEqual(SIGNATURE_CAP_CHARS);
    expect(rendered.endsWith(SIGNATURE_ELLIPSIS)).toBe(true);
    expect(rendered.startsWith("const big = ")).toBe(true);
  });
});

describe("renderSignature: class / interface members", () => {
  it("renders a method up to (but not including) the body", () => {
    const sourceFile = parseTs("class C { greet(name: string): string { return name; } }\n");
    const method = sourceFile.getClasses()[0]!.getMethods()[0]!;
    expect(renderSignature(method)).toBe("greet(name: string): string");
  });

  it("renders a static method preserving modifiers", () => {
    const sourceFile = parseTs("class C { static run(): void {} }\n");
    const method = sourceFile.getClasses()[0]!.getMethods()[0]!;
    expect(renderSignature(method)).toBe("static run(): void");
  });

  it("renders an abstract method dropping the trailing semicolon", () => {
    const sourceFile = parseTs("abstract class C { abstract run(): void; }\n");
    const method = sourceFile.getClasses()[0]!.getMethods()[0]!;
    expect(renderSignature(method)).toBe("abstract run(): void");
  });

  it("renders a getter and setter with their accessor keyword", () => {
    const sourceFile = parseTs(
      "class C { get value(): number { return 1; } set value(v: number) {} }\n",
    );
    const cls = sourceFile.getClasses()[0]!;
    expect(renderSignature(cls.getGetAccessors()[0]!)).toBe("get value(): number");
    expect(renderSignature(cls.getSetAccessors()[0]!)).toBe("set value(v: number)");
  });

  it("renders an interface method signature dropping the trailing semicolon", () => {
    const sourceFile = parseTs("interface I { run(x: number): string; }\n");
    const member = sourceFile.getInterfaces()[0]!.getMethods()[0]!;
    expect(renderSignature(member)).toBe("run(x: number): string");
  });

  it("renders a property declaration including initializer when no annotation", () => {
    const sourceFile = parseTs("class C { count = 0; }\n");
    const prop = sourceFile.getClasses()[0]!.getProperties()[0]!;
    expect(renderSignature(prop)).toBe("count = 0");
  });

  it("renders a property declaration with annotation only when annotated", () => {
    const sourceFile = parseTs("class C { count: number = 0; }\n");
    const prop = sourceFile.getClasses()[0]!.getProperties()[0]!;
    expect(renderSignature(prop)).toBe("count: number");
  });
});

describe("renderSignature: default exports", () => {
  it("renders 'export default <expr>' as the expression text", () => {
    const node = firstStatement("export default 42;\n");
    expect(renderSignature(node)).toBe("export default 42");
  });
});
