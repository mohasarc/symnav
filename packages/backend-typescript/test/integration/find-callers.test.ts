import { describe, expect, it } from "vitest";

import { InMemoryFileSystem, type CallEdge, type ResolvedPath } from "@symnav/core";

import { TypeScriptBackend } from "../../src/typescript-backend/typescript-backend.js";

const CALL_GRAPH_CASES: Record<string, string> = {
  "/repo/.git/HEAD": "ref: refs/heads/main\n",
  "/repo/src/callers/targets.ts": [
    "export function calledFromTwoFiles(): void {}",
    "export function calledTwice(): void {}",
    "export function calledFromTest(): void {}",
    "export function neverCalled(): void {}",
    "export function calledDynamically(): void {}",
    "export function calledFromNestedTraversal(): void {}",
    "export function mentionedNotCalled(): void {}",
    "export function calledFromFunctionValuedConst(): void {}",
    "export function calledFromTopLevelHandler(): void {}",
    "export function calledFromParenthesizedArrow(): void {}",
    "export function calledFromFunctionExpression(): void {}",
    "export function calledFromExpressionBody(): void {}",
    "export function calledFromOrdinaryInitializer(): number { return 1; }",
    "export function calledFromTopLevelInitializer(): number { return 1; }",
    "export function calledFromAnonymousCallback(): void {}",
    "export function calledAfterUnrelatedLineOne(): void {}",
    "export function calledFromFirstSameLineOwner(): void {}",
    "export function calledFromSetter(): void {}",
    "",
  ].join("\n"),
  "/repo/src/callers/file-a.ts": [
    'import { calledFromTwoFiles } from "./targets.js";',
    "",
    "export function callerInA(): void {",
    "  calledFromTwoFiles();",
    "}",
    "",
  ].join("\n"),
  "/repo/src/callers/file-b.ts": [
    'import { calledFromTwoFiles } from "./targets.js";',
    "",
    "export function callerInB(): void {",
    "  calledFromTwoFiles();",
    "}",
    "",
  ].join("\n"),
  "/repo/src/callers/twice.ts": [
    'import { calledTwice } from "./targets.js";',
    "",
    "export function callsItTwice(): void {",
    "  calledTwice();",
    "  calledTwice();",
    "}",
    "",
  ].join("\n"),
  "/repo/src/callers/sample.test.ts": [
    'import { calledFromTest } from "./targets.js";',
    "",
    "export function testCaller(): void {",
    "  calledFromTest();",
    "}",
    "",
  ].join("\n"),
  "/repo/src/callers/mentions.ts": [
    'import { mentionedNotCalled } from "./targets.js";',
    "",
    "export const handleRef = mentionedNotCalled;",
    "export type AliasOf = typeof mentionedNotCalled;",
    "",
  ].join("\n"),
  "/repo/src/callers/dynamic.ts": [
    'import { calledDynamically } from "./targets.js";',
    "",
    "export function fallback(): void {}",
    "",
    "export function dynamicCaller(cond: boolean): void {",
    "  (cond ? calledDynamically : fallback)();",
    "}",
    "",
  ].join("\n"),
  "/repo/src/callers/nested.ts": [
    'import { calledFromNestedTraversal } from "./targets.js";',
    "",
    "export function nestedCaller(items: number[], enabled: boolean): void {",
    "  if (enabled) {",
    "    for (const item of items) {",
    "      {",
    "        [item].forEach(() => {",
    "          calledFromNestedTraversal();",
    "        });",
    "      }",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n"),
  "/repo/src/callers/function-valued-const.ts": [
    'import { calledFromFunctionValuedConst } from "./targets.js";',
    "",
    "export function bar(): void {",
    "  const handler = () => {",
    "    calledFromFunctionValuedConst();",
    "  };",
    "  handler();",
    "}",
    "",
  ].join("\n"),
  "/repo/src/callers/top-level-handler.ts": [
    'import { calledFromTopLevelHandler } from "./targets.js";',
    "",
    "export const handler = () => {",
    "  calledFromTopLevelHandler();",
    "};",
    "",
  ].join("\n"),
  "/repo/src/callers/function-value-shapes.ts": [
    "export function unrelatedLineOne(): void {}",
    'import { calledAfterUnrelatedLineOne, calledFromExpressionBody, calledFromFunctionExpression, calledFromParenthesizedArrow } from "./targets.js";',
    "",
    "export const afterUnrelatedLineOne = () => {",
    "  calledAfterUnrelatedLineOne();",
    "};",
    "",
    "export const parenthesizedArrow = (() => {",
    "  calledFromParenthesizedArrow();",
    "});",
    "",
    "export const functionExpression = function () {",
    "  calledFromFunctionExpression();",
    "};",
    "",
    "export const expressionBody = () => calledFromExpressionBody();",
    "",
  ].join("\n"),
  "/repo/src/callers/initializer-boundaries.ts": [
    'import { calledFromAnonymousCallback, calledFromOrdinaryInitializer, calledFromTopLevelInitializer } from "./targets.js";',
    "",
    "export function enclosingCallable(): void {",
    "  const result = calledFromOrdinaryInitializer();",
    "  [result].forEach(() => {",
    "    calledFromAnonymousCallback();",
    "  });",
    "}",
    "",
    "export const topLevelResult = calledFromTopLevelInitializer();",
    "",
  ].join("\n"),
  "/repo/src/callers/same-line-function-values.ts": [
    'import { calledFromFirstSameLineOwner } from "./targets.js";',
    "",
    "export const firstSameLineOwner = () => { calledFromFirstSameLineOwner(); }, secondSameLineOwner = () => {};",
    "",
  ].join("\n"),
  "/repo/src/callers/setter.ts": [
    'import { calledFromSetter } from "./targets.js";',
    "",
    "export class Host {",
    "  private stored = 0;",
    "",
    "  set value(next: number) {",
    "    this.stored = next;",
    "    calledFromSetter();",
    "  }",
    "}",
    "",
  ].join("\n"),
};

const ALL_FILES: readonly ResolvedPath[] = [
  "src/callers/dynamic.ts",
  "src/callers/file-a.ts",
  "src/callers/file-b.ts",
  "src/callers/function-value-shapes.ts",
  "src/callers/function-valued-const.ts",
  "src/callers/initializer-boundaries.ts",
  "src/callers/mentions.ts",
  "src/callers/nested.ts",
  "src/callers/sample.test.ts",
  "src/callers/same-line-function-values.ts",
  "src/callers/setter.ts",
  "src/callers/targets.ts",
  "src/callers/top-level-handler.ts",
  "src/callers/twice.ts",
].map((relative) => ({ relative, absolute: `/repo/${relative}` }));

function backend(): TypeScriptBackend {
  return new TypeScriptBackend(new InMemoryFileSystem(CALL_GRAPH_CASES));
}

function segmentNames(edge: CallEdge): string[] {
  return edge.symbol.identity.segments.map((segment) => segment.name);
}

function callersOf(symbol: string): Promise<readonly CallEdge[]> {
  return backend().findCallers(ALL_FILES, {
    file: "src/callers/targets.ts",
    segments: [{ name: symbol }],
  });
}

describe("TypeScriptBackend.findCallers", () => {
  it("maps callers from two different files to their enclosing symbols", async () => {
    const edges = await callersOf("calledFromTwoFiles");
    expect(edges.map((edge) => edge.confidence)).toEqual(["certain", "certain"]);
    expect(edges.map(segmentNames)).toEqual([["callerInA"], ["callerInB"]]);
    expect(edges.every((edge) => edge.sites.length === 1)).toBe(true);
    expect(edges[0]!.sites[0]!.previewSource).toContain("calledFromTwoFiles()");
  });

  it("groups one caller's repeated calls into a single edge with sorted sites", async () => {
    const edges = await callersOf("calledTwice");
    expect(edges).toHaveLength(1);
    expect(segmentNames(edges[0]!)).toEqual(["callsItTwice"]);
    expect(edges[0]!.sites).toHaveLength(2);
    const lines = edges[0]!.sites.map((site) => site.line);
    expect(lines[0]).toBeLessThan(lines[1]!);
  });

  it("includes callers that live in test files", async () => {
    const edges = await callersOf("calledFromTest");
    expect(edges).toHaveLength(1);
    expect(segmentNames(edges[0]!)).toEqual(["testCaller"]);
    expect(edges[0]!.sites[0]!.file).toBe("src/callers/sample.test.ts");
  });

  it("finds callers inside nested control flow and callbacks", async () => {
    const edges = await callersOf("calledFromNestedTraversal");
    expect(edges).toHaveLength(1);
    expect(segmentNames(edges[0]!)).toEqual(["nestedCaller"]);
    expect(edges[0]!.sites[0]!.file).toBe("src/callers/nested.ts");
    expect(edges[0]!.sites[0]!.previewSource).toContain("calledFromNestedTraversal()");
  });

  it("returns no edges for a symbol with no callers", async () => {
    const edges = await callersOf("neverCalled");
    expect(edges).toEqual([]);
  });

  it("ignores references that are imports or type-only mentions, not calls", async () => {
    const edges = await callersOf("mentionedNotCalled");
    expect(edges).toEqual([]);
  });

  it("attributes a call inside a local function-valued const to that const", async () => {
    const edges = await callersOf("calledFromFunctionValuedConst");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.symbol.identity).toEqual({
      file: "src/callers/function-valued-const.ts",
      segments: [{ name: "bar" }, { name: "handler" }],
    });
  });

  it("does not confuse a top-level execution owner with an unrelated line-one declaration", async () => {
    const edges = await callersOf("calledAfterUnrelatedLineOne");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.symbol.identity).toEqual({
      file: "src/callers/function-value-shapes.ts",
      segments: [{ name: "afterUnrelatedLineOne" }],
    });
  });

  it("attributes a call to the correct function-valued variable when two start on one line", async () => {
    const edges = await callersOf("calledFromFirstSameLineOwner");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.symbol.identity).toEqual({
      file: "src/callers/same-line-function-values.ts",
      segments: [{ name: "firstSameLineOwner" }],
    });
  });

  it.each([
    ["calledFromParenthesizedArrow", "parenthesizedArrow"],
    ["calledFromFunctionExpression", "functionExpression"],
    ["calledFromExpressionBody", "expressionBody"],
  ])("attributes %s to function-valued variable %s", async (target, owner) => {
    const edges = await callersOf(target);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.symbol.identity).toEqual({
      file: "src/callers/function-value-shapes.ts",
      segments: [{ name: owner }],
    });
  });

  it("keeps an ordinary initializer call owned by its enclosing callable", async () => {
    const edges = await callersOf("calledFromOrdinaryInitializer");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.symbol.identity).toEqual({
      file: "src/callers/initializer-boundaries.ts",
      segments: [{ name: "enclosingCallable" }],
    });
  });

  it("does not invent a caller for a top-level ordinary initializer", async () => {
    await expect(callersOf("calledFromTopLevelInitializer")).resolves.toEqual([]);
  });

  it("keeps an anonymous callback owned by its enclosing declared callable", async () => {
    const edges = await callersOf("calledFromAnonymousCallback");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.symbol.identity).toEqual({
      file: "src/callers/initializer-boundaries.ts",
      segments: [{ name: "enclosingCallable" }],
    });
  });

  it("attributes a call inside a setter to that setter", async () => {
    const edges = await callersOf("calledFromSetter");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.symbol.identity).toEqual({
      file: "src/callers/setter.ts",
      segments: [{ name: "Host" }, { name: "value" }],
    });
  });

  it("falls back to the function-valued const itself when no enclosing non-value symbol exists", async () => {
    const edges = await callersOf("calledFromTopLevelHandler");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.symbol.identity).toEqual({
      file: "src/callers/top-level-handler.ts",
      segments: [{ name: "handler" }],
    });
  });

  it("tags an indirect dispatch caller as a possible edge with a reason", async () => {
    const edges = await callersOf("calledDynamically");
    expect(edges).toHaveLength(1);
    expect(segmentNames(edges[0]!)).toEqual(["dynamicCaller"]);
    expect(edges[0]!.confidence).toBe("possible");
    expect(edges[0]!.reason).toBeTruthy();
  });
});
