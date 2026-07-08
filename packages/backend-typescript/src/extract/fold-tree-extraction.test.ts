import { describe, expect, it } from "vitest";
import type { FoldOverviewNode, OverviewFileEntries, OverviewNode } from "@symnav/core";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { extractFileEntries } from "./extract-file-entries.js";

function fileEntriesOf(source: string): OverviewFileEntries {
  return extractFileEntries({
    sourceFile: parseTypeScriptSource(source),
    filePath: "input.ts",
  });
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
            foldKind: "switch",
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
            foldKind: "switch",
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
});
