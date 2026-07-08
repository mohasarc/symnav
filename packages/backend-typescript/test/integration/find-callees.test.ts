import { describe, expect, it } from "vitest";

import { InMemoryFileSystem, type CallEdge, type ResolvedPath } from "@symnav/core";

import { TypeScriptBackend } from "../../src/typescript-backend/typescript-backend.js";

const CALL_GRAPH_CASES: Record<string, string> = {
  "/repo/.git/HEAD": "ref: refs/heads/main\n",
  "/repo/src/callees/helpers.ts": [
    "export function helperA(): void {}",
    "export function helperB(): void {}",
    "",
  ].join("\n"),
  "/repo/src/callees/shapes.ts": [
    "export class WithConstructor {",
    "  constructor(public x: number) {}",
    "}",
    "",
    "export class NoConstructor {",
    "  run(): void {}",
    "}",
    "",
  ].join("\n"),
  "/repo/src/callees/dispatch.ts": [
    'import { helperA, helperB } from "./helpers.js";',
    "",
    "type Action = () => void;",
    "interface Registry {",
    "  [key: string]: Action;",
    "}",
    "",
    "declare const unknownTable: Record<string, Action>;",
    "const recordTable: Record<string, Action> = { a: helperA, b: helperB };",
    "const interfaceTable: Registry = { a: helperA, b: helperB };",
    "const concreteTable = { a: helperA, b: helperB };",
    "const arrayTable = [helperA, helperB];",
    "",
    "export function recordDispatch(key: string): void {",
    "  recordTable[key]();",
    "}",
    "",
    "export function interfaceDispatch(key: string): void {",
    "  interfaceTable[key]();",
    "}",
    "",
    'export function concreteUnionDispatch(key: "a" | "b"): void {',
    "  concreteTable[key]();",
    "}",
    "",
    "export function concreteElementAccess(): void {",
    '  concreteTable["a"]();',
    "}",
    "",
    "export function arrayDispatch(index: number): void {",
    "  arrayTable[index]();",
    "}",
    "",
    "export function conditionalDispatch(flag: boolean): void {",
    "  (flag ? helperA : helperB)();",
    "}",
    "",
    "export function unknownDispatch(key: string): void {",
    "  unknownTable[key]();",
    "}",
    "",
  ].join("\n"),
  "/repo/src/callees/bodies.ts": [
    'import { helperA, helperB } from "./helpers.js";',
    'import { WithConstructor, NoConstructor } from "./shapes.js";',
    "",
    "export function callsTwo(): void {",
    "  helperA();",
    "  helperB();",
    "}",
    "",
    "export function callsTwice(): void {",
    "  helperA();",
    "  helperA();",
    "}",
    "",
    "export function constructsWithConstructor(): void {",
    "  new WithConstructor(1);",
    "}",
    "",
    "export function constructsNoConstructor(): void {",
    "  new NoConstructor();",
    "}",
    "",
    "export function callsExternal(): void {",
    '  console.log("hi");',
    "}",
    "",
    "export function callsThroughControlFlow(flag: boolean, items: string[]): void {",
    "  if (flag) {",
    "    helperA();",
    "  } else {",
    "    for (const item of items) {",
    "      if (item) {",
    "        helperB();",
    "      }",
    "    }",
    "  }",
    "  while (flag) {",
    "    helperA();",
    "    break;",
    "  }",
    "}",
    "",
    "export function recurses(n: number): number {",
    "  if (n <= 0) return 0;",
    "  return recurses(n - 1);",
    "}",
    "",
    "export function empty(): void {}",
    "",
  ].join("\n"),
};

const ALL_FILES: readonly ResolvedPath[] = [
  "src/callees/bodies.ts",
  "src/callees/dispatch.ts",
  "src/callees/helpers.ts",
  "src/callees/shapes.ts",
].map((relative) => ({ relative, absolute: `/repo/${relative}` }));

function backend(): TypeScriptBackend {
  return new TypeScriptBackend(new InMemoryFileSystem(CALL_GRAPH_CASES));
}

function segmentNames(edge: CallEdge): string[] {
  return edge.symbol.identity.segments.map((segment) => segment.name);
}

function calleesOf(symbol: string): Promise<readonly CallEdge[]> {
  return backend().findCallees(ALL_FILES, {
    file: "src/callees/bodies.ts",
    segments: [{ name: symbol }],
  });
}

function dispatchCalleesOf(symbol: string): Promise<readonly CallEdge[]> {
  return backend().findCallees(ALL_FILES, {
    file: "src/callees/dispatch.ts",
    segments: [{ name: symbol }],
  });
}

describe("TypeScriptBackend.findCallees", () => {
  it("discovers two cross-file callees as certain edges with one site each", async () => {
    const edges = await calleesOf("callsTwo");
    expect(edges.map((edge) => edge.confidence)).toEqual(["certain", "certain"]);
    expect(edges.map(segmentNames)).toEqual([["helperA"], ["helperB"]]);
    expect(edges.every((edge) => edge.sites.length === 1)).toBe(true);
    expect(edges.every((edge) => edge.symbol.header.lines.length > 0)).toBe(true);
  });

  it("groups repeated calls to one callee into a single edge with sorted sites", async () => {
    const edges = await calleesOf("callsTwice");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.sites).toHaveLength(2);
    const lines = edges[0]!.sites.map((site) => site.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(lines[0]).toBeLessThan(lines[1]!);
  });

  it("maps a constructed class with a constructor to the constructor symbol", async () => {
    const edges = await calleesOf("constructsWithConstructor");
    expect(edges).toHaveLength(1);
    expect(segmentNames(edges[0]!)).toEqual(["WithConstructor", "constructor"]);
  });

  it("maps a constructed class with no constructor to the class symbol", async () => {
    const edges = await calleesOf("constructsNoConstructor");
    expect(edges).toHaveLength(1);
    expect(segmentNames(edges[0]!)).toEqual(["NoConstructor"]);
    expect(edges[0]!.symbol.kind.role).toBe("container");
  });

  it("drops calls to symbols outside the workspace", async () => {
    const edges = await calleesOf("callsExternal");
    expect(edges).toEqual([]);
  });

  it("discovers calls nested inside control-flow blocks", async () => {
    const edges = await calleesOf("callsThroughControlFlow");
    expect(edges.map(segmentNames)).toEqual([["helperA"], ["helperB"]]);
    expect(edges.map((edge) => edge.sites.map((site) => site.line))).toEqual([[28, 37], [32]]);
  });

  it("resolves record table values as possible dynamic callees without reporting the type alias", async () => {
    const edges = await dispatchCalleesOf("recordDispatch");
    expect(edges.map(segmentNames)).toEqual([["helperA"], ["helperB"]]);
    expect(edges.map((edge) => edge.confidence)).toEqual(["possible", "possible"]);
    expect(edges.every((edge) => edge.symbol.kind.role === "callable")).toBe(true);
  });

  it("resolves interface table values as possible dynamic callees", async () => {
    const edges = await dispatchCalleesOf("interfaceDispatch");
    expect(edges.map(segmentNames)).toEqual([["helperA"], ["helperB"]]);
    expect(edges.map((edge) => edge.confidence)).toEqual(["possible", "possible"]);
  });

  it("filters concrete object table candidates by union key type", async () => {
    const edges = await dispatchCalleesOf("concreteUnionDispatch");
    expect(edges.map(segmentNames)).toEqual([["helperA"], ["helperB"]]);
    expect(edges.map((edge) => edge.confidence)).toEqual(["possible", "possible"]);
  });

  it("resolves concrete element-access callees when the target member is known", async () => {
    const edges = await dispatchCalleesOf("concreteElementAccess");
    expect(edges.map(segmentNames)).toEqual([["helperA"]]);
    expect(edges[0]!.confidence).toBe("certain");
  });

  it("resolves array element candidates as possible dynamic callees", async () => {
    const edges = await dispatchCalleesOf("arrayDispatch");
    expect(edges.map(segmentNames)).toEqual([["helperA"], ["helperB"]]);
    expect(edges.map((edge) => edge.confidence)).toEqual(["possible", "possible"]);
  });

  it("resolves conditional expression branches as possible dynamic callees", async () => {
    const edges = await dispatchCalleesOf("conditionalDispatch");
    expect(edges.map(segmentNames)).toEqual([["helperA"], ["helperB"]]);
    expect(edges.map((edge) => edge.confidence)).toEqual(["possible", "possible"]);
  });

  it("ignores dynamic calls when only the callable shape is known", async () => {
    const edges = await dispatchCalleesOf("unknownDispatch");
    expect(edges).toEqual([]);
  });

  it("includes a self-edge for a recursive symbol", async () => {
    const edges = await calleesOf("recurses");
    expect(edges.map(segmentNames)).toContainEqual(["recurses"]);
  });

  it("returns no edges for a symbol with an empty body", async () => {
    const edges = await calleesOf("empty");
    expect(edges).toEqual([]);
  });
});
