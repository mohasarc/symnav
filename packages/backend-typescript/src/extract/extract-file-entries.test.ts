import { describe, expect, it } from "vitest";
import {
  CollectingDiagnosticSink,
  formatSymbolIdentity,
  SymbolTargetGrammar,
  OverviewTree,
  type FoldOverviewNode,
  type OverviewFileEntries,
  type OverviewNode,
  type SymbolOverviewNode,
} from "@symnav/core";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { extractFileEntries } from "./extract-file-entries.js";

function fileEntriesOf(
  source: string,
  filePath: string = "input.ts",
  diagnostics?: CollectingDiagnosticSink,
): OverviewFileEntries {
  const sourceFile = parseTypeScriptSource(source);
  return extractFileEntries({ sourceFile, filePath, diagnostics });
}

function foldSummaries(nodes: readonly OverviewNode[]): readonly unknown[] {
  return nodes.map((node) => {
    if (node.type === "symbol") {
      return {
        type: "symbol",
        name: node.identity.segments.map((segment) => segment.name).join("::"),
        header: node.header.lines,
        children: foldSummaries(node.children),
      };
    }
    if (node.type === "re-export") {
      return {
        type: "re-export",
        exportKind: node.exportKind,
        exportedNames: node.exportedNames,
        sourceModule: node.sourceModule,
        header: node.header.lines,
      };
    }
    return {
      type: "fold",
      foldKind: node.foldKind,
      header: node.header.lines,
      children: foldSummaries(node.children),
    };
  });
}

function onlyFold(source: string): FoldOverviewNode {
  const entry = fileEntriesOf(source).entries[0];
  if (!entry || entry.type !== "fold") {
    throw new Error("expected fold entry");
  }
  return entry;
}

function symbolsOf(source: string, filePath: string = "input.ts"): readonly SymbolOverviewNode[] {
  return OverviewTree.walkSymbols(fileEntriesOf(source, filePath).entries);
}

function symbolChildren(symbol: SymbolOverviewNode): readonly SymbolOverviewNode[] {
  return OverviewTree.walkSymbols(symbol.children);
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
    expect(result.map((s) => [s.kind.nativeLabel, OverviewTree.ownName(s)])).toEqual([
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
    expect(symbolChildren(cls).map((c) => [c.kind.nativeLabel, OverviewTree.ownName(c)])).toEqual([
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
    expect(symbolChildren(iface).map((c) => [c.kind.nativeLabel, OverviewTree.ownName(c)])).toEqual(
      [
        ["property", "x"],
        ["method-declaration", "m"],
        ["index-signature", "[index]"],
        ["call-signature", "()"],
        ["construct-signature", "new()"],
      ],
    );
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
    expect(OverviewTree.ownName(children[0]!)).toBe("inner");
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
    expect(result.map((s) => [s.kind.nativeLabel, OverviewTree.ownName(s)])).toEqual([
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
    expect(result.map((symbol) => OverviewTree.ownName(symbol))).toEqual(["render"]);
  });

  it("ignores expression statements and empty statements at the top level", () => {
    const source = ["sideEffect();", ";"].join("\n");
    const result = symbolsOf(source);
    expect(result).toEqual([]);
  });

  it("ignores executable control-flow statements that contain no declarations", () => {
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
    expect(result.map((symbol) => formatSymbolIdentity(symbol.identity))).toEqual([
      "input.ts::inner",
    ]);
  });

  it("discovers declarations nested inside executable control-flow blocks", () => {
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
    if (!outer) throw new Error("expected outer");

    expect(
      OverviewTree.directFolds(outer.children).map((fold) => [fold.foldKind, fold.header.lines]),
    ).toEqual([
      ["conditional", ["if (flag) {"]],
      ["loop", ["for (const item of items) {"]],
    ]);
    expect(symbolChildren(outer).map((symbol) => formatSymbolIdentity(symbol.identity))).toEqual([
      "input.ts::outer::insideIf",
      "input.ts::outer::insideLoop",
    ]);
  });

  it("discovers declarations inside a function-valued variable initializer body", () => {
    const source = ["const handler = () => {", "  function inner() {}", "};"].join("\n");
    const handler = symbolsOf(source)[0];
    if (!handler) throw new Error("expected handler");
    expect(symbolChildren(handler).map((symbol) => formatSymbolIdentity(symbol.identity))).toEqual([
      "input.ts::handler::inner",
    ]);
  });

  it("discovers declarations inside a function-expression variable initializer body", () => {
    const source = ["const handler = function () {", "  function inner() {}", "};"].join("\n");
    const handler = symbolsOf(source)[0];
    if (!handler) throw new Error("expected handler");
    expect(symbolChildren(handler).map((symbol) => formatSymbolIdentity(symbol.identity))).toEqual([
      "input.ts::handler::inner",
    ]);
  });

  it("discovers declarations inside a default-exported arrow function body", () => {
    const source = ["export default () => {", "  const nested = () => {};", "};"].join("\n");
    const defaultExport = symbolsOf(source)[0];
    if (!defaultExport) throw new Error("expected default export");
    expect(defaultExport.kind.nativeLabel).toBe("default-export");
    expect(
      symbolChildren(defaultExport).map((symbol) => formatSymbolIdentity(symbol.identity)),
    ).toEqual(["input.ts::default::nested"]);
  });

  it("discovers declarations inside a default-exported function expression body", () => {
    const source = ["export default (function () {", "  const nested = 1;", "});"].join("\n");
    const defaultExport = symbolsOf(source)[0];
    if (!defaultExport) throw new Error("expected default export");
    expect(
      symbolChildren(defaultExport).map((symbol) => formatSymbolIdentity(symbol.identity)),
    ).toEqual(["input.ts::default::nested"]);
  });

  it("ignores class static blocks but counts other members", () => {
    const source = ["class C {", "  static {}", "  m() {}", "}"].join("\n");
    const result = symbolsOf(source);
    const cls = result[0];
    if (!cls) throw new Error("expected class");
    expect(symbolChildren(cls).map((c) => [c.kind.nativeLabel, OverviewTree.ownName(c)])).toEqual([
      ["method-implementation", "m"],
    ]);
  });

  it("extracts a private field whose canonical id round-trips", () => {
    const result = symbolsOf("class C { #secret = 1; }");
    const cls = result[0];
    if (!cls) throw new Error("expected class");
    const field = symbolChildren(cls)[0];
    if (!field) throw new Error("expected private field");
    expect(OverviewTree.ownName(field)).toBe("#secret");
    const id = formatSymbolIdentity(field.identity);
    const pattern = SymbolTargetGrammar.parse(id);
    expect(
      formatSymbolIdentity({ file: pattern.fileSuffix!, segments: pattern.segmentSuffix }),
    ).toBe(id);
  });
});

describe("fold tree extraction", () => {
  it("fuses a top-level call and trailing callback into one fold with callback body children", () => {
    const source = ['describe("x", () => {', "  const helper = () => {};", "});"].join("\n");

    expect(foldSummaries(fileEntriesOf(source).entries)).toEqual([
      {
        type: "fold",
        foldKind: "call",
        header: ['describe("x", () => {'],
        children: [
          {
            type: "symbol",
            name: "helper",
            header: ["const helper = () => {}"],
            children: [],
          },
        ],
      },
    ]);
  });

  it("extracts common control-flow folds with bounded headers and nested symbols", () => {
    const source = [
      "if (flag) {",
      "  function insideIf(): void {}",
      "}",
      "for (let i = 0; i < 2; i++) {",
      "  const insideFor = i;",
      "}",
      "for (const value of values) {",
      "  const insideForOf = value;",
      "}",
      "for (const key in values) {",
      "  const insideForIn = key;",
      "}",
      "while (keepGoing) {",
      "  const insideWhile = keepGoing;",
      "}",
      "switch (kind) {",
      "  case 1: {",
      "    const insideCase = kind;",
      "    break;",
      "  }",
      "  default: {",
      "    const insideDefault = kind;",
      "  }",
      "}",
      "try {",
      "  const insideTry = run();",
      "} catch (error) {",
      "  const insideCatch = error;",
      "} finally {",
      "  const insideFinally = true;",
      "}",
      "{",
      "  const insideBlock = true;",
      "}",
    ].join("\n");

    expect(foldSummaries(fileEntriesOf(source).entries)).toEqual([
      {
        type: "fold",
        foldKind: "conditional",
        header: ["if (flag) {"],
        children: [
          { type: "symbol", name: "insideIf", header: ["function insideIf(): void"], children: [] },
        ],
      },
      {
        type: "fold",
        foldKind: "loop",
        header: ["for (let i = 0; i < 2; i++) {"],
        children: [
          { type: "symbol", name: "insideFor", header: ["const insideFor = i"], children: [] },
        ],
      },
      {
        type: "fold",
        foldKind: "loop",
        header: ["for (const value of values) {"],
        children: [
          {
            type: "symbol",
            name: "insideForOf",
            header: ["const insideForOf = value"],
            children: [],
          },
        ],
      },
      {
        type: "fold",
        foldKind: "loop",
        header: ["for (const key in values) {"],
        children: [
          {
            type: "symbol",
            name: "insideForIn",
            header: ["const insideForIn = key"],
            children: [],
          },
        ],
      },
      {
        type: "fold",
        foldKind: "loop",
        header: ["while (keepGoing) {"],
        children: [
          {
            type: "symbol",
            name: "insideWhile",
            header: ["const insideWhile = keepGoing"],
            children: [],
          },
        ],
      },
      {
        type: "fold",
        foldKind: "switch",
        header: ["switch (kind) {"],
        children: [
          {
            type: "fold",
            foldKind: "switchCase",
            header: ["case 1:"],
            children: [
              {
                type: "symbol",
                name: "insideCase",
                header: ["const insideCase = kind"],
                children: [],
              },
            ],
          },
          {
            type: "fold",
            foldKind: "switchDefault",
            header: ["default:"],
            children: [
              {
                type: "symbol",
                name: "insideDefault",
                header: ["const insideDefault = kind"],
                children: [],
              },
            ],
          },
        ],
      },
      {
        type: "fold",
        foldKind: "try",
        header: ["try {"],
        children: [
          {
            type: "symbol",
            name: "insideTry",
            header: ["const insideTry = run()"],
            children: [],
          },
        ],
      },
      {
        type: "fold",
        foldKind: "catch",
        header: ["catch (error) {"],
        children: [
          {
            type: "symbol",
            name: "insideCatch",
            header: ["const insideCatch = error"],
            children: [],
          },
        ],
      },
      {
        type: "fold",
        foldKind: "finally",
        header: ["finally {"],
        children: [
          {
            type: "symbol",
            name: "insideFinally",
            header: ["const insideFinally = true"],
            children: [],
          },
        ],
      },
      {
        type: "fold",
        foldKind: "block",
        header: ["{"],
        children: [
          {
            type: "symbol",
            name: "insideBlock",
            header: ["const insideBlock = true"],
            children: [],
          },
        ],
      },
    ]);
  });

  it("splits a multi-line fold header into newline-free lines starting at the fold's line", () => {
    const source = [
      "if (",
      "  flag &&",
      "  other",
      ") {",
      "  function insideIf(): void {}",
      "}",
    ].join("\n");

    const fold = onlyFold(source);

    expect(fold.header.startLine).toBe(1);
    expect(fold.header.lines).toEqual(["if (", "  flag &&", "  other", ") {"]);
    for (const line of fold.header.lines) {
      expect(line).not.toContain("\n");
    }
  });

  it("fuses an awaited call with a trailing callback", () => {
    const source = ["await runSuite(() => {", "  const helper = 1;", "});"].join("\n");

    expect(foldSummaries(fileEntriesOf(source).entries)).toEqual([
      {
        type: "fold",
        foldKind: "call",
        header: ["await runSuite(() => {"],
        children: [
          {
            type: "symbol",
            name: "helper",
            header: ["const helper = 1"],
            children: [],
          },
        ],
      },
    ]);
  });

  it("fuses an assigned call with a trailing callback", () => {
    const source = ["x = register(() => {", "  const helper = 1;", "});"].join("\n");

    expect(foldSummaries(fileEntriesOf(source).entries)).toEqual([
      {
        type: "fold",
        foldKind: "call",
        header: ["x = register(() => {"],
        children: [
          {
            type: "symbol",
            name: "helper",
            header: ["const helper = 1"],
            children: [],
          },
        ],
      },
    ]);
  });

  it("fuses an assigned awaited call with a trailing callback", () => {
    const source = ["x = await f(() => {", "  const helper = 1;", "});"].join("\n");

    expect(foldSummaries(fileEntriesOf(source).entries)).toEqual([
      {
        type: "fold",
        foldKind: "call",
        header: ["x = await f(() => {"],
        children: [
          {
            type: "symbol",
            name: "helper",
            header: ["const helper = 1"],
            children: [],
          },
        ],
      },
    ]);
  });

  it("does not fuse through compound assignment operators like += and ??=", () => {
    const source = [
      "x += register(() => {",
      "  const helper = 1;",
      "});",
      "y ??= register(() => {",
      "  const other = 1;",
      "});",
    ].join("\n");

    expect(foldSummaries(fileEntriesOf(source).entries)).toEqual([]);
  });

  it("does not turn nested call expressions into symbols", () => {
    const source = ["const value = compute(run());", "", "effect();"].join("\n");

    expect(foldSummaries(fileEntriesOf(source).entries)).toEqual([
      {
        type: "symbol",
        name: "value",
        header: ["const value = compute(run())"],
        children: [],
      },
      {
        type: "fold",
        foldKind: "call",
        header: ["effect();"],
        children: [],
      },
    ]);
  });

  it("extracts nested callback bodies behind foldable call arguments", () => {
    const fold = onlyFold(
      ["suite(() => {", "  test(() => {", "    const nested = true;", "  });", "});"].join("\n"),
    );

    expect(foldSummaries(fold.children)).toEqual([
      {
        type: "fold",
        foldKind: "call",
        header: ["test(() => {"],
        children: [
          {
            type: "symbol",
            name: "nested",
            header: ["const nested = true"],
            children: [],
          },
        ],
      },
    ]);
  });
});

describe("re-export extraction", () => {
  it("extracts star, named, and namespace re-export entries without target symbols", () => {
    const source = [
      'export * from "./core";',
      'export { A, B as C } from "./api";',
      'export * as ns from "./ns";',
    ].join("\n");

    expect(foldSummaries(fileEntriesOf(source).entries)).toEqual([
      {
        type: "re-export",
        exportKind: "star",
        exportedNames: [],
        sourceModule: "./core",
        header: ['export * from "./core";'],
      },
      {
        type: "re-export",
        exportKind: "named",
        exportedNames: ["A", "C"],
        sourceModule: "./api",
        header: ['export { A, B as C } from "./api";'],
      },
      {
        type: "re-export",
        exportKind: "namespace",
        exportedNames: ["ns"],
        sourceModule: "./ns",
        header: ['export * as ns from "./ns";'],
      },
    ]);
  });

  it("extracts default re-exports, direct and aliased", () => {
    const source = [
      'export { default } from "./mod";',
      'export { x as default } from "./other";',
    ].join("\n");

    expect(foldSummaries(fileEntriesOf(source).entries)).toEqual([
      {
        type: "re-export",
        exportKind: "named",
        exportedNames: ["default"],
        sourceModule: "./mod",
        header: ['export { default } from "./mod";'],
      },
      {
        type: "re-export",
        exportKind: "named",
        exportedNames: ["default"],
        sourceModule: "./other",
        header: ['export { x as default } from "./other";'],
      },
    ]);
  });

  it("splits a multi-line re-export header into newline-free lines starting at its line", () => {
    const source = ["export {", "  A,", "  B as C,", '} from "./api";'].join("\n");

    const entry = fileEntriesOf(source).entries[0];
    if (!entry || entry.type !== "re-export") throw new Error("expected re-export entry");

    expect(entry.header.startLine).toBe(1);
    expect(entry.header.lines).toEqual(["export {", "  A,", "  B as C,", '} from "./api";']);
    for (const line of entry.header.lines) {
      expect(line).not.toContain("\n");
    }
  });

  it("extracts a specifier-less named export without reporting a diagnostic", () => {
    const diagnostics = new CollectingDiagnosticSink();
    const source = ["const a = 1;", "export { a };"].join("\n");

    const entries = fileEntriesOf(source, "input.ts", diagnostics).entries;

    expect(foldSummaries(entries).at(-1)).toEqual({
      type: "re-export",
      exportKind: "named",
      exportedNames: ["a"],
      sourceModule: undefined,
      header: ["export { a };"],
    });
    expect(diagnostics.diagnostics()).toEqual([]);
  });

  it("classifies an empty named clause with a specifier as a star re-export", () => {
    expect(foldSummaries(fileEntriesOf('export {} from "./m";').entries)).toEqual([
      {
        type: "re-export",
        exportKind: "star",
        exportedNames: [],
        sourceModule: "./m",
        header: ['export {} from "./m";'],
      },
    ]);
  });

  it("extracts a bare empty export without reporting a diagnostic", () => {
    const diagnostics = new CollectingDiagnosticSink();

    const entries = fileEntriesOf("export {};", "input.ts", diagnostics).entries;

    expect(foldSummaries(entries)).toEqual([
      {
        type: "re-export",
        exportKind: "named",
        exportedNames: [],
        sourceModule: undefined,
        header: ["export {};"],
      },
    ]);
    expect(diagnostics.diagnostics()).toEqual([]);
  });
});
