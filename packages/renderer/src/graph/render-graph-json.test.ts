import { describe, expect, it } from "vitest";

import type {
  GraphDirectionPage,
  GraphPath,
  GraphPathStep,
  GraphResult,
  SymbolDecl,
  SymbolPathSegment,
} from "@symnav/core";

import { renderGraphJson } from "./render-graph-json.js";

interface DeclInput {
  readonly file: string;
  readonly segments: readonly SymbolPathSegment[];
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: readonly string[];
}

interface GraphResultOverrides {
  readonly direction?: GraphResult["direction"];
  readonly incoming?: GraphDirectionPage;
  readonly omitOutgoing?: boolean;
  readonly page?: GraphResult["page"];
  readonly pageCount?: GraphResult["pageCount"];
  readonly repeatedSymbolCount?: GraphResult["repeatedSymbolCount"];
}

function decl(input: DeclInput): SymbolDecl {
  return {
    identity: { file: input.file, segments: input.segments },
    kind: { role: "callable", nativeLabel: "function-implementation" },
    range: { startLine: input.startLine, endLine: input.endLine },
    signature: { startLine: input.startLine, lines: input.signature },
    children: [],
  };
}

function step(symbol: SymbolDecl): GraphPathStep {
  return { symbol, confidence: "certain", closesCycle: false };
}

function path(...steps: readonly GraphPathStep[]): GraphPath {
  return { steps };
}

function graphResult(root: SymbolDecl, overrides: GraphResultOverrides = {}): GraphResult {
  return {
    identity: root.identity,
    root,
    depth: 2,
    direction: overrides.direction ?? "both",
    incoming: overrides.incoming ?? { paths: [], totalPathCount: 0 },
    ...(overrides.omitOutgoing ? {} : { outgoing: { paths: [], totalPathCount: 0 } }),
    page: overrides.page ?? 1,
    pageCount: overrides.pageCount ?? 1,
    repeatedSymbolCount: overrides.repeatedSymbolCount ?? 0,
  };
}

describe("renderGraphJson", () => {
  it("round-trips graph result fields", () => {
    const root = decl({
      file: "src/root.ts",
      segments: [{ name: "root" }],
      startLine: 1,
      endLine: 4,
      signature: ["function root()"],
    });
    const caller = decl({
      file: "src/caller.ts",
      segments: [{ name: "caller" }],
      startLine: 8,
      endLine: 12,
      signature: ["function caller()"],
    });
    const graph = graphResult(root, {
      direction: "incoming",
      incoming: { paths: [path(step(caller))], totalPathCount: 1 },
      omitOutgoing: true,
      page: 2,
      pageCount: 3,
      repeatedSymbolCount: 1,
    });

    expect(JSON.parse(renderGraphJson(graph))).toEqual(graph);
  });
});
