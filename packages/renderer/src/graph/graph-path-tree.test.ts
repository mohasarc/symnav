import { describe, expect, it } from "vitest";

import type { GraphPath, GraphPathStep, SymbolDecl, SymbolPathSegment } from "@symnav/core";

import { buildGraphPathTree } from "./graph-path-tree.js";

interface DeclInput {
  readonly file: string;
  readonly segments: readonly SymbolPathSegment[];
  readonly startLine: number;
  readonly endLine: number;
  readonly header: readonly string[];
}

function decl(input: DeclInput): SymbolDecl {
  return {
    type: "symbol",
    identity: { file: input.file, segments: input.segments },
    kind: { role: "callable", nativeLabel: "function-implementation" },
    range: { startLine: input.startLine, endLine: input.endLine },
    header: { startLine: input.startLine, lines: input.header },
    children: [],
  };
}

function step(symbol: SymbolDecl, options: { readonly closesCycle?: boolean } = {}): GraphPathStep {
  return {
    symbol,
    confidence: "certain",
    closesCycle: options.closesCycle ?? false,
  };
}

function path(...steps: readonly GraphPathStep[]): GraphPath {
  return { steps };
}

describe("buildGraphPathTree", () => {
  it("merges paths with the same first step and preserves first occurrence order", () => {
    const shared = decl({
      file: "src/shared.ts",
      segments: [{ name: "shared" }],
      startLine: 1,
      endLine: 3,
      header: ["function shared()"],
    });
    const first = decl({
      file: "src/first.ts",
      segments: [{ name: "first" }],
      startLine: 5,
      endLine: 7,
      header: ["function first()"],
    });
    const second = decl({
      file: "src/second.ts",
      segments: [{ name: "second" }],
      startLine: 9,
      endLine: 11,
      header: ["function second()"],
    });

    const tree = buildGraphPathTree([
      path(step(shared), step(first)),
      path(step(shared), step(second)),
    ]);

    expect(tree).toEqual([
      {
        step: step(shared),
        children: [
          { step: step(first), children: [] },
          { step: step(second), children: [] },
        ],
      },
    ]);
  });

  it("does not attach children to a cycle-closing step", () => {
    const cycle = decl({
      file: "src/cycle.ts",
      segments: [{ name: "cycle" }],
      startLine: 1,
      endLine: 1,
      header: ["function cycle()"],
    });
    const unreachable = decl({
      file: "src/unreachable.ts",
      segments: [{ name: "unreachable" }],
      startLine: 2,
      endLine: 2,
      header: ["function unreachable()"],
    });

    const tree = buildGraphPathTree([path(step(cycle, { closesCycle: true }), step(unreachable))]);

    expect(tree).toEqual([{ step: step(cycle, { closesCycle: true }), children: [] }]);
  });
});
