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
    "export function mentionedNotCalled(): void {}",
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
};

const ALL_FILES: readonly ResolvedPath[] = [
  "src/callers/dynamic.ts",
  "src/callers/file-a.ts",
  "src/callers/file-b.ts",
  "src/callers/mentions.ts",
  "src/callers/sample.test.ts",
  "src/callers/targets.ts",
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

  it("returns no edges for a symbol with no callers", async () => {
    const edges = await callersOf("neverCalled");
    expect(edges).toEqual([]);
  });

  it("ignores references that are imports or type-only mentions, not calls", async () => {
    const edges = await callersOf("mentionedNotCalled");
    expect(edges).toEqual([]);
  });

  it("tags an indirect dispatch caller as a possible edge with a reason", async () => {
    const edges = await callersOf("calledDynamically");
    expect(edges).toHaveLength(1);
    expect(segmentNames(edges[0]!)).toEqual(["dynamicCaller"]);
    expect(edges[0]!.confidence).toBe("possible");
    expect(edges[0]!.reason).toBeTruthy();
  });
});
