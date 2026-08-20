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
    "export function calledFromManyOwners(): void {}",
    "export function calledFromClassPropertyArrow(): void {}",
    "export function calledFromClassPropertyFunctionExpression(): void {}",
    "export function calledFromStaticPropertyArrow(): void {}",
    "export function calledFromStaticPropertyInitializer(): number { return 1; }",
    "export function calledFromStaticBlock(): void {}",
    "export function calledFromPropertyInitializer(): number { return 1; }",
    "export function calledFromDecoratorArgument(): number { return 1; }",
    "export function calledFromObjectLiteralMethod(): void {}",
    "export function calledFromObjectLiteralArrow(): void {}",
    "export function calledFromObjectLiteralGetter(): number { return 1; }",
    "export function calledFromNestedObjectLiteralMethod(): void {}",
    'export function calledFromComputedKey(): string { return "k"; }',
    "export function calledFromTopLevelCallback(): number { return 1; }",
    "export function calledFromClassExpressionMethod(): void {}",
    "export function calledFromHeritageClause(): number { return 1; }",
    "export function calledFromEnumMember(): number { return 1; }",
    "export function calledFromNamespaceInitializer(): number { return 1; }",
    "export function calledFromDefaultExportArrow(): void {}",
    "export function calledFromAssignedArrow(): void {}",
    "export function calledFromModuleStatement(): void {}",
    "export function calledFromModuleIife(): void {}",
    "export function calledFromModuleLoop(): void {}",
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
  "/repo/src/callers/many-owners.ts": [
    'import { calledFromManyOwners } from "./targets.js";',
    "",
    "export function plainCaller(): void {",
    "  calledFromManyOwners();",
    "}",
    "",
    "export class Service {",
    "  onEvent = () => {",
    "    calledFromManyOwners();",
    "  };",
    "",
    "  run(): void {",
    "    calledFromManyOwners();",
    "  }",
    "}",
    "",
    "export const handler = () => {",
    "  calledFromManyOwners();",
    "};",
    "",
    "export const seeded = calledFromManyOwners();",
    "",
    "calledFromManyOwners();",
    "",
  ].join("\n"),
  "/repo/src/callers/class-member-shapes.ts": [
    "import {",
    "  calledFromClassPropertyArrow,",
    "  calledFromClassPropertyFunctionExpression,",
    "  calledFromDecoratorArgument,",
    "  calledFromPropertyInitializer,",
    "  calledFromStaticBlock,",
    "  calledFromStaticPropertyArrow,",
    "  calledFromStaticPropertyInitializer,",
    '} from "./targets.js";',
    "",
    "function deco(_value: number) {",
    "  return (_target: unknown, _context: unknown) => {};",
    "}",
    "",
    "export class Widget {",
    "  handle = () => {",
    "    calledFromClassPropertyArrow();",
    "  };",
    "",
    "  handleExpression = function () {",
    "    calledFromClassPropertyFunctionExpression();",
    "  };",
    "",
    "  static staticHandle = () => {",
    "    calledFromStaticPropertyArrow();",
    "  };",
    "",
    "  static staticSeed = calledFromStaticPropertyInitializer();",
    "",
    "  static {",
    "    calledFromStaticBlock();",
    "  }",
    "",
    "  seed = calledFromPropertyInitializer();",
    "",
    "  @deco(calledFromDecoratorArgument())",
    "  decorated(): void {}",
    "}",
    "",
  ].join("\n"),
  "/repo/src/callers/object-literal-shapes.ts": [
    "import {",
    "  calledFromComputedKey,",
    "  calledFromNestedObjectLiteralMethod,",
    "  calledFromObjectLiteralArrow,",
    "  calledFromObjectLiteralGetter,",
    "  calledFromObjectLiteralMethod,",
    '} from "./targets.js";',
    "",
    "export const api = {",
    "  run() {",
    "    calledFromObjectLiteralMethod();",
    "  },",
    "  arrow: () => {",
    "    calledFromObjectLiteralArrow();",
    "  },",
    "  get value() {",
    "    return calledFromObjectLiteralGetter();",
    "  },",
    "  inner: {",
    "    run() {",
    "      calledFromNestedObjectLiteralMethod();",
    "    },",
    "  },",
    "  [calledFromComputedKey()]: 1,",
    "};",
    "",
  ].join("\n"),
  "/repo/src/callers/definition-time-shapes.ts": [
    "import {",
    "  calledFromClassExpressionMethod,",
    "  calledFromEnumMember,",
    "  calledFromHeritageClause,",
    "  calledFromNamespaceInitializer,",
    "  calledFromTopLevelCallback,",
    '} from "./targets.js";',
    "",
    "function mix(_value: number) {",
    "  return class {};",
    "}",
    "",
    "export const list = [1].map(() => calledFromTopLevelCallback());",
    "",
    "export const Klass = class {",
    "  method(): void {",
    "    calledFromClassExpressionMethod();",
    "  }",
    "};",
    "",
    "export class Derived extends mix(calledFromHeritageClause()) {}",
    "",
    "export enum Flags {",
    "  A = calledFromEnumMember(),",
    "}",
    "",
    "export namespace Space {",
    "  export const value = calledFromNamespaceInitializer();",
    "}",
    "",
  ].join("\n"),
  "/repo/src/callers/default-export-arrow.ts": [
    'import { calledFromDefaultExportArrow } from "./targets.js";',
    "",
    "export default () => {",
    "  calledFromDefaultExportArrow();",
    "};",
    "",
  ].join("\n"),
  "/repo/src/callers/assigned-arrow.ts": [
    'import { calledFromAssignedArrow } from "./targets.js";',
    "",
    "export let late: () => void;",
    "",
    "late = () => {",
    "  calledFromAssignedArrow();",
    "};",
    "",
  ].join("\n"),
  "/repo/src/callers/module-scope-shapes.ts": [
    'import { calledFromModuleIife, calledFromModuleLoop, calledFromModuleStatement } from "./targets.js";',
    "",
    "calledFromModuleStatement();",
    "",
    "(() => {",
    "  calledFromModuleIife();",
    "})();",
    "",
    "for (const item of [1]) {",
    "  calledFromModuleLoop();",
    "}",
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
  "src/callers/assigned-arrow.ts",
  "src/callers/class-member-shapes.ts",
  "src/callers/default-export-arrow.ts",
  "src/callers/definition-time-shapes.ts",
  "src/callers/dynamic.ts",
  "src/callers/file-a.ts",
  "src/callers/file-b.ts",
  "src/callers/function-value-shapes.ts",
  "src/callers/function-valued-const.ts",
  "src/callers/initializer-boundaries.ts",
  "src/callers/many-owners.ts",
  "src/callers/mentions.ts",
  "src/callers/module-scope-shapes.ts",
  "src/callers/nested.ts",
  "src/callers/object-literal-shapes.ts",
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

  it("attributes a top-level initializer call to the initialized declaration", async () => {
    const edges = await callersOf("calledFromTopLevelInitializer");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.symbol.identity).toEqual({
      file: "src/callers/initializer-boundaries.ts",
      segments: [{ name: "topLevelResult" }],
    });
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

  it("attributes a top-level function-valued const call to that const", async () => {
    const edges = await callersOf("calledFromTopLevelHandler");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.symbol.identity).toEqual({
      file: "src/callers/top-level-handler.ts",
      segments: [{ name: "handler" }],
    });
  });

  it("reports every distinct owner when one target is called from many shapes", async () => {
    const edges = await callersOf("calledFromManyOwners");
    expect(edges.map(segmentNames)).toEqual([
      ["plainCaller"],
      ["Service", "onEvent"],
      ["Service", "run"],
      ["handler"],
      ["seeded"],
    ]);
    expect(edges.every((edge) => edge.sites.length === 1)).toBe(true);
  });

  it.each([
    ["calledFromClassPropertyArrow", "class-member-shapes", "Widget.handle"],
    ["calledFromClassPropertyFunctionExpression", "class-member-shapes", "Widget.handleExpression"],
    ["calledFromStaticPropertyArrow", "class-member-shapes", "Widget.staticHandle"],
    ["calledFromStaticPropertyInitializer", "class-member-shapes", "Widget.staticSeed"],
    ["calledFromStaticBlock", "class-member-shapes", "Widget"],
    ["calledFromPropertyInitializer", "class-member-shapes", "Widget.seed"],
    ["calledFromDecoratorArgument", "class-member-shapes", "Widget"],
    ["calledFromObjectLiteralMethod", "object-literal-shapes", "api"],
    ["calledFromObjectLiteralArrow", "object-literal-shapes", "api"],
    ["calledFromObjectLiteralGetter", "object-literal-shapes", "api"],
    ["calledFromNestedObjectLiteralMethod", "object-literal-shapes", "api"],
    ["calledFromComputedKey", "object-literal-shapes", "api"],
    ["calledFromTopLevelCallback", "definition-time-shapes", "list"],
    ["calledFromClassExpressionMethod", "definition-time-shapes", "Klass"],
    ["calledFromHeritageClause", "definition-time-shapes", "Derived"],
    ["calledFromEnumMember", "definition-time-shapes", "Flags"],
    ["calledFromNamespaceInitializer", "definition-time-shapes", "Space.value"],
    ["calledFromDefaultExportArrow", "default-export-arrow", "default"],
    ["calledFromAssignedArrow", "assigned-arrow", "late"],
  ])("attributes %s to %s.ts::%s", async (target, file, owner) => {
    const edges = await callersOf(target);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.symbol.identity).toEqual({
      file: `src/callers/${file}.ts`,
      segments: owner.split(".").map((name) => ({ name })),
    });
  });

  it.each(["calledFromModuleStatement", "calledFromModuleIife", "calledFromModuleLoop"])(
    "reports no caller for %s, which has no owner above module scope",
    async (target) => {
      await expect(callersOf(target)).resolves.toEqual([]);
    },
  );

  it("tags an indirect dispatch caller as a possible edge with a reason", async () => {
    const edges = await callersOf("calledDynamically");
    expect(edges).toHaveLength(1);
    expect(segmentNames(edges[0]!)).toEqual(["dynamicCaller"]);
    expect(edges[0]!.confidence).toBe("possible");
    expect(edges[0]!.reason).toBeTruthy();
  });
});
