import { describe, expect, it } from "vitest";
import { Node, type SourceFile } from "ts-morph";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { nodeKind } from "./node-kind.js";

function firstStatement(file: SourceFile) {
  const stmt = file.getStatements()[0];
  if (!stmt) throw new Error("expected at least one statement");
  return stmt;
}

describe("nodeKind", () => {
  it("classifies a plain function declaration as function", () => {
    const file = parseTypeScriptSource("function f() {}");
    expect(nodeKind(firstStatement(file))).toBe("function");
  });

  it("classifies an async function declaration as function", () => {
    const file = parseTypeScriptSource("async function f() {}");
    expect(nodeKind(firstStatement(file))).toBe("function");
  });

  it("classifies a generator function declaration as function", () => {
    const file = parseTypeScriptSource("function* g() {}");
    expect(nodeKind(firstStatement(file))).toBe("function");
  });

  it("classifies a class declaration as class", () => {
    const file = parseTypeScriptSource("class C {}");
    expect(nodeKind(firstStatement(file))).toBe("class");
  });

  it("classifies an interface declaration as interface", () => {
    const file = parseTypeScriptSource("interface I {}");
    expect(nodeKind(firstStatement(file))).toBe("interface");
  });

  it("classifies a type alias declaration as type-alias", () => {
    const file = parseTypeScriptSource("type T = number;");
    expect(nodeKind(firstStatement(file))).toBe("type-alias");
  });

  it("classifies an enum declaration as enum", () => {
    const file = parseTypeScriptSource("enum E { A }");
    expect(nodeKind(firstStatement(file))).toBe("enum");
  });

  it("classifies a namespace declaration as namespace", () => {
    const file = parseTypeScriptSource("namespace N {}");
    expect(nodeKind(firstStatement(file))).toBe("namespace");
  });

  it("classifies a class method as method", () => {
    const file = parseTypeScriptSource("class C { m() {} }");
    const cls = firstStatement(file);
    if (!Node.isClassDeclaration(cls)) throw new Error("expected class");
    const member = cls.getMembers()[0];
    if (!member) throw new Error("expected member");
    expect(nodeKind(member)).toBe("method");
  });

  it("classifies a class constructor as constructor", () => {
    const file = parseTypeScriptSource("class C { constructor() {} }");
    const cls = firstStatement(file);
    if (!Node.isClassDeclaration(cls)) throw new Error("expected class");
    const member = cls.getMembers()[0];
    if (!member) throw new Error("expected member");
    expect(nodeKind(member)).toBe("constructor");
  });

  it("classifies a class getter as getter", () => {
    const file = parseTypeScriptSource("class C { get x() { return 1; } }");
    const cls = firstStatement(file);
    if (!Node.isClassDeclaration(cls)) throw new Error("expected class");
    const member = cls.getMembers()[0];
    if (!member) throw new Error("expected member");
    expect(nodeKind(member)).toBe("getter");
  });

  it("classifies a class setter as setter", () => {
    const file = parseTypeScriptSource("class C { set x(v: number) {} }");
    const cls = firstStatement(file);
    if (!Node.isClassDeclaration(cls)) throw new Error("expected class");
    const member = cls.getMembers()[0];
    if (!member) throw new Error("expected member");
    expect(nodeKind(member)).toBe("setter");
  });

  it("classifies a class property as property", () => {
    const file = parseTypeScriptSource("class C { x: number = 1; }");
    const cls = firstStatement(file);
    if (!Node.isClassDeclaration(cls)) throw new Error("expected class");
    const member = cls.getMembers()[0];
    if (!member) throw new Error("expected member");
    expect(nodeKind(member)).toBe("property");
  });

  it("classifies an interface property as property", () => {
    const file = parseTypeScriptSource("interface I { x: number; }");
    const iface = firstStatement(file);
    if (!Node.isInterfaceDeclaration(iface)) throw new Error("expected interface");
    const member = iface.getMembers()[0];
    if (!member) throw new Error("expected member");
    expect(nodeKind(member)).toBe("property");
  });

  it("classifies an interface method as method", () => {
    const file = parseTypeScriptSource("interface I { m(): void; }");
    const iface = firstStatement(file);
    if (!Node.isInterfaceDeclaration(iface)) throw new Error("expected interface");
    const member = iface.getMembers()[0];
    if (!member) throw new Error("expected member");
    expect(nodeKind(member)).toBe("method");
  });

  it("classifies an interface index signature as index-signature", () => {
    const file = parseTypeScriptSource("interface I { [k: string]: number; }");
    const iface = firstStatement(file);
    if (!Node.isInterfaceDeclaration(iface)) throw new Error("expected interface");
    const member = iface.getMembers()[0];
    if (!member) throw new Error("expected member");
    expect(nodeKind(member)).toBe("index-signature");
  });

  it("classifies an interface call signature as call-signature", () => {
    const file = parseTypeScriptSource("interface I { (): void; }");
    const iface = firstStatement(file);
    if (!Node.isInterfaceDeclaration(iface)) throw new Error("expected interface");
    const member = iface.getMembers()[0];
    if (!member) throw new Error("expected member");
    expect(nodeKind(member)).toBe("call-signature");
  });

  it("classifies an interface construct signature as construct-signature", () => {
    const file = parseTypeScriptSource("interface I { new (): object; }");
    const iface = firstStatement(file);
    if (!Node.isInterfaceDeclaration(iface)) throw new Error("expected interface");
    const member = iface.getMembers()[0];
    if (!member) throw new Error("expected member");
    expect(nodeKind(member)).toBe("construct-signature");
  });

  it("classifies a variable statement as variable", () => {
    const file = parseTypeScriptSource("const x = 1;");
    expect(nodeKind(firstStatement(file))).toBe("variable");
  });

  it("classifies an export-default expression statement as default-export", () => {
    const file = parseTypeScriptSource("export default 42;");
    expect(nodeKind(firstStatement(file))).toBe("default-export");
  });

  it("returns null for a re-export statement", () => {
    const file = parseTypeScriptSource("export { foo } from './x';");
    expect(nodeKind(firstStatement(file))).toBeNull();
  });

  it("returns null for a bare import statement", () => {
    const file = parseTypeScriptSource("import './side';");
    expect(nodeKind(firstStatement(file))).toBeNull();
  });
});
