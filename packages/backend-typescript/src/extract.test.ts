import { parseTs } from "@symnav/testing";
import { describe, expect, it } from "vitest";
import { nodeKind } from "./extract.js";

function firstStatement(source: string) {
  const sourceFile = parseTs(source);
  const stmt = sourceFile.getStatements()[0];
  if (!stmt) {
    throw new Error("expected at least one statement");
  }
  return stmt;
}

describe("nodeKind", () => {
  it("classifies a function declaration as 'function'", () => {
    expect(nodeKind(firstStatement("function f() {}"))).toBe("function");
  });

  it("classifies a class declaration as 'class'", () => {
    expect(nodeKind(firstStatement("class C {}"))).toBe("class");
  });

  it("classifies an interface declaration as 'interface'", () => {
    expect(nodeKind(firstStatement("interface I {}"))).toBe("interface");
  });

  it("classifies a type alias as 'type-alias'", () => {
    expect(nodeKind(firstStatement("type T = number;"))).toBe("type-alias");
  });

  it("classifies an enum declaration as 'enum'", () => {
    expect(nodeKind(firstStatement("enum E { A, B }"))).toBe("enum");
  });

  it("classifies a namespace declaration as 'namespace'", () => {
    expect(nodeKind(firstStatement("namespace N {}"))).toBe("namespace");
  });

  it("classifies an export default declaration as 'default-export'", () => {
    expect(nodeKind(firstStatement("export default 42;"))).toBe("default-export");
  });

  it("returns null for re-export and bare-import statements", () => {
    expect(nodeKind(firstStatement("export { foo } from './x';"))).toBeNull();
    expect(nodeKind(firstStatement("import './side-effect';"))).toBeNull();
  });

  it("classifies class members by accessor / kind", () => {
    const sourceFile = parseTs(
      [
        "class C {",
        "  prop = 1;",
        "  constructor() {}",
        "  method() {}",
        "  get value() { return 1; }",
        "  set value(v: number) {}",
        "  [key: string]: number;",
        "}",
        "",
      ].join("\n"),
    );
    const cls = sourceFile.getClasses()[0];
    if (!cls) throw new Error("expected class");
    const members = cls.getMembers();
    const kinds = members.map((m) => nodeKind(m));
    expect(kinds).toEqual([
      "property",
      "constructor",
      "method",
      "getter",
      "setter",
      "index-signature",
    ]);
  });

  it("classifies interface members by call/construct/index/method/property", () => {
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
    const iface = sourceFile.getInterfaces()[0];
    if (!iface) throw new Error("expected interface");
    const kinds = iface.getMembers().map((m) => nodeKind(m));
    expect(kinds).toEqual([
      "property",
      "method",
      "call-signature",
      "construct-signature",
      "index-signature",
    ]);
  });
});
