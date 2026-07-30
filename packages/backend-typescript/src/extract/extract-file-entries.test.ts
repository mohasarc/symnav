import { describe, expect, it } from "vitest";
import {
  formatSymbolIdentity,
  parseSymbolIdentity,
  walkOverviewSymbols,
  type OverviewFileEntries,
  type SymbolOverviewNode,
} from "@symnav/core";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { extractFileEntries } from "./extract-file-entries.js";

function fileEntriesOf(source: string, filePath: string = "input.ts"): OverviewFileEntries {
  const sourceFile = parseTypeScriptSource(source);
  return extractFileEntries({ sourceFile, filePath });
}

function symbolsOf(source: string, filePath: string = "input.ts"): readonly SymbolOverviewNode[] {
  return walkOverviewSymbols(fileEntriesOf(source, filePath).entries);
}

function symbolChildren(decl: SymbolOverviewNode): readonly SymbolOverviewNode[] {
  return walkOverviewSymbols(decl.children);
}

function ownName(decl: SymbolOverviewNode): string {
  const segments = decl.identity.segments;
  return segments[segments.length - 1]?.name ?? "";
}

describe("extractFileEntries", () => {
  it("produces OverviewFileEntries with empty symbols for an empty source", () => {
    const result = fileEntriesOf("");
    expect(result.entries).toEqual([]);
  });

  it("forwards filePath verbatim onto the IR", () => {
    const result = fileEntriesOf("export const x = 1;", "src/foo/bar.ts");
    expect(result.file).toBe("src/foo/bar.ts");
  });

  it("enumerates top-level declarations in source order across all forms", () => {
    const source = [
      "export function fn() {}",
      "export class Cls {}",
      "export interface Iface {}",
      "export type Alias = number;",
      "export enum Mode { On }",
      "export namespace Ns {}",
      "export const variable = 1;",
      "export default 42;",
    ].join("\n");
    const result = symbolsOf(source);
    expect(result.map((s) => [s.kind.nativeLabel, ownName(s)])).toEqual([
      ["function-implementation", "fn"],
      ["class", "Cls"],
      ["interface", "Iface"],
      ["type-alias", "Alias"],
      ["enum", "Mode"],
      ["namespace", "Ns"],
      ["variable", "variable"],
      ["default-export", "default"],
    ]);
  });

  it("class children include constructor, method, getter, setter, property, static method, abstract method", () => {
    const source = [
      "export abstract class Base {",
      "  prop: number = 1;",
      "  constructor() {}",
      "  method() {}",
      "  get value(): number { return this.prop; }",
      "  set value(v: number) { this.prop = v; }",
      "  static helper() {}",
      "  abstract overrideMe(): void;",
      "}",
    ].join("\n");
    const result = symbolsOf(source);
    const cls = result[0];
    if (!cls) throw new Error("expected class");
    expect(symbolChildren(cls).map((c) => [c.kind.nativeLabel, ownName(c)])).toEqual([
      ["property", "prop"],
      ["constructor-implementation", "constructor"],
      ["method-implementation", "method"],
      ["getter", "value"],
      ["setter", "value"],
      ["method-implementation", "helper"],
      ["method-declaration", "overrideMe"],
    ]);
  });

  it("interface children include properties, methods, index signature, call signature, construct signature", () => {
    const source = [
      "export interface I {",
      "  x: number;",
      "  m(): void;",
      "  [k: string]: unknown;",
      "  (): void;",
      "  new (): object;",
      "}",
    ].join("\n");
    const result = symbolsOf(source);
    const iface = result[0];
    if (!iface) throw new Error("expected interface");
    expect(symbolChildren(iface).map((c) => [c.kind.nativeLabel, ownName(c)])).toEqual([
      ["property", "x"],
      ["method-declaration", "m"],
      ["index-signature", "[index]"],
      ["call-signature", "()"],
      ["construct-signature", "new()"],
    ]);
  });

  it("recurses through namespaces — nested function appears as a child function", () => {
    const source = ["export namespace Outer {", "  export function inner() {}", "}"].join("\n");
    const result = symbolsOf(source);
    const ns = result[0];
    if (!ns) throw new Error("expected namespace");
    expect(ns.kind.nativeLabel).toBe("namespace");
    const children = symbolChildren(ns);
    expect(children).toHaveLength(1);
    expect(children[0]?.kind.nativeLabel).toBe("function-implementation");
    expect(children[0]).toBeDefined();
    expect(ownName(children[0]!)).toBe("inner");
  });

  it("a nested decl's identity carries the full ancestor chain in path", () => {
    const source = ["export namespace Outer {", "  export function inner() {}", "}"].join("\n");
    const result = symbolsOf(source);
    const nested = result[0] ? symbolChildren(result[0])[0] : undefined;
    expect(nested?.identity).toEqual({
      file: "input.ts",
      segments: [{ name: "Outer" }, { name: "inner" }],
    });
  });

  it("expands a single `const a = 1, b = 2;` into two separate variable decls with their own ranges", () => {
    const result = symbolsOf("const a = 1, b = 2;");
    expect(result.map((s) => [s.kind.nativeLabel, ownName(s)])).toEqual([
      ["variable", "a"],
      ["variable", "b"],
    ]);
    expect(result[0]?.range).toEqual({ startLine: 1, endLine: 1 });
    expect(result[1]?.range).toEqual({ startLine: 1, endLine: 1 });
    expect(result[0]?.header.lines).toEqual(["const a = 1"]);
    expect(result[1]?.header.lines).toEqual(["const b = 2"]);
  });

  it("variable signature preserves modifiers, type annotation, and initializer", () => {
    expect(symbolsOf("export const x = 1;")[0]?.header.lines).toEqual(["export const x = 1"]);
    expect(symbolsOf("export const x: number = 1;")[0]?.header.lines).toEqual([
      "export const x: number = 1",
    ]);
    expect(symbolsOf("declare const y: T;")[0]?.header.lines).toEqual(["declare const y: T"]);
  });

  it("signature carries startLine equal to range.startLine and newline-free lines", () => {
    const result = symbolsOf("export const x = 1;");
    const decl = result[0];
    if (!decl) throw new Error("expected decl");
    expect(decl.header.startLine).toBe(decl.range.startLine);
    expect(decl.header.lines.length).toBeGreaterThan(0);
    for (const line of decl.header.lines) {
      expect(line).not.toContain("\n");
    }
  });

  it("a multi-line declaration produces one signature line per source line", () => {
    const source = ["function multi(", "  arg: number,", ") {", "  return arg;", "}"].join("\n");
    const decl = symbolsOf(source)[0];
    if (!decl) throw new Error("expected decl");
    expect(decl.header.startLine).toBe(1);
    expect(decl.header.lines).toEqual(["function multi(", "  arg: number,", ")"]);
  });

  it("single-line decls have startLine === endLine; multi-line decls span exact source lines", () => {
    const source = [
      "function oneLine() {}",
      "function multi(",
      "  arg: number,",
      ") {",
      "  return arg;",
      "}",
    ].join("\n");
    const result = symbolsOf(source);
    expect(result[0]?.range).toEqual({ startLine: 1, endLine: 1 });
    expect(result[1]?.range).toEqual({ startLine: 2, endLine: 6 });
  });

  it("re-exports and bare imports produce no decls", () => {
    const source = ["export { foo } from './x';", "import './side-effect';"].join("\n");
    const result = symbolsOf(source);
    expect(result).toEqual([]);
  });

  it("ignores namespace exports and keeps following declarations", () => {
    const source = ["export as namespace katex;", "export function render() {}"].join("\n");
    const result = symbolsOf(source);
    expect(result.map((symbol) => ownName(symbol))).toEqual(["render"]);
  });

  it("ignores expression statements and empty statements at the top level", () => {
    const source = ["sideEffect();", ";"].join("\n");
    const result = symbolsOf(source);
    expect(result).toEqual([]);
  });

  it("ignores top-level executable control-flow statements", () => {
    const source = [
      "if (true) { sideEffect(); }",
      "for (const x of []) {}",
      "for (const x in {}) {}",
      "for (let i = 0; i < 1; i++) {}",
      "while (false) {}",
      "do {} while (false);",
      "switch (x) { case 1: break; default: break; }",
      "try { run(); } catch (e) {} finally {}",
      "throw new Error('x');",
      "label: { break label; }",
      "{ const inner = 1; }",
      "debugger;",
    ].join("\n");
    const result = symbolsOf(source);
    expect(result).toEqual([]);
  });

  it.skip("discovers declarations nested inside executable control-flow blocks", () => {
    const source = [
      "export function outer(flag: boolean, items: readonly string[]): void {",
      "  if (flag) {",
      "    function insideIf(): void {}",
      "  }",
      "  for (const item of items) {",
      "    const insideLoop = item;",
      "  }",
      "}",
    ].join("\n");
    const outer = symbolsOf(source)[0];
    expect(outer ? symbolChildren(outer).map(ownName) : undefined).toEqual([
      "insideIf",
      "insideLoop",
    ]);
  });

  it("ignores class static blocks but counts other members", () => {
    const source = ["class C {", "  static {}", "  m() {}", "}"].join("\n");
    const result = symbolsOf(source);
    const cls = result[0];
    if (!cls) throw new Error("expected class");
    expect(symbolChildren(cls).map((c) => [c.kind.nativeLabel, ownName(c)])).toEqual([
      ["method-implementation", "m"],
    ]);
  });

  it("extracts a private field whose canonical id round-trips", () => {
    const result = symbolsOf("class C { #secret = 1; }");
    const cls = result[0];
    if (!cls) throw new Error("expected class");
    const field = symbolChildren(cls)[0];
    if (!field) throw new Error("expected private field");
    expect(ownName(field)).toBe("#secret");
    expect(parseSymbolIdentity(formatSymbolIdentity(field.identity))).toEqual(field.identity);
  });
});
