import { describe, expect, it } from "vitest";
import type { FileSymbols } from "@symnav/core";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { extractFileSymbols } from "./extract-file-symbols.js";

function symbolsOf(source: string, filePath: string = "input.ts"): FileSymbols {
  const sourceFile = parseTypeScriptSource(source);
  return extractFileSymbols({ sourceFile, filePath });
}

describe("extractFileSymbols", () => {
  it("produces FileSymbols with empty symbols for an empty source", () => {
    const result = symbolsOf("");
    expect(result.symbols).toEqual([]);
  });

  it("forwards filePath verbatim onto the IR", () => {
    const result = symbolsOf("export const x = 1;", "src/foo/bar.ts");
    expect(result.filePath).toBe("src/foo/bar.ts");
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
    expect(result.symbols.map((s) => [s.kind, s.name])).toEqual([
      ["function", "fn"],
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
    const cls = result.symbols[0];
    if (!cls) throw new Error("expected class");
    expect(cls.children.map((c) => [c.kind, c.name])).toEqual([
      ["property", "prop"],
      ["constructor", "constructor"],
      ["method", "method"],
      ["getter", "value"],
      ["setter", "value"],
      ["method", "helper"],
      ["method", "overrideMe"],
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
    const iface = result.symbols[0];
    if (!iface) throw new Error("expected interface");
    expect(iface.children.map((c) => [c.kind, c.name])).toEqual([
      ["property", "x"],
      ["method", "m"],
      ["index-signature", "[index]"],
      ["call-signature", "()"],
      ["construct-signature", "new()"],
    ]);
  });

  it("recurses through namespaces — nested function appears as a child function", () => {
    const source = ["export namespace Outer {", "  export function inner() {}", "}"].join("\n");
    const result = symbolsOf(source);
    const ns = result.symbols[0];
    if (!ns) throw new Error("expected namespace");
    expect(ns.kind).toBe("namespace");
    expect(ns.children).toHaveLength(1);
    expect(ns.children[0]?.kind).toBe("function");
    expect(ns.children[0]?.name).toBe("inner");
  });

  it("expands a single `const a = 1, b = 2;` into two separate variable decls with their own ranges", () => {
    const result = symbolsOf("const a = 1, b = 2;");
    expect(result.symbols.map((s) => [s.kind, s.name])).toEqual([
      ["variable", "a"],
      ["variable", "b"],
    ]);
    expect(result.symbols[0]?.range).toEqual({ startLine: 1, endLine: 1 });
    expect(result.symbols[1]?.range).toEqual({ startLine: 1, endLine: 1 });
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
    expect(result.symbols[0]?.range).toEqual({ startLine: 1, endLine: 1 });
    expect(result.symbols[1]?.range).toEqual({ startLine: 2, endLine: 6 });
  });

  it("re-exports and bare imports produce no decls", () => {
    const source = ["export { foo } from './x';", "import './side-effect';"].join("\n");
    const result = symbolsOf(source);
    expect(result.symbols).toEqual([]);
  });
});
