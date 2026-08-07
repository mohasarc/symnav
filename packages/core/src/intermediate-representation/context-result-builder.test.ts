import { describe, expect, it } from "vitest";

import type { CallEdge, EdgeConfidence } from "./call-edge.js";
import { ContextResultBuilder } from "./context-result-builder.js";
import { DEFAULT_CONTEXT_CAP } from "./context-result.js";
import type { HistoryEntry } from "../git/git-history.js";
import type { SymbolReference } from "./references.js";
import type { SymbolIdentity } from "./symbol-identity.js";
import type { SymbolOverviewNode } from "./overview-tree.js";

const identity: SymbolIdentity = {
  file: "src/target.ts",
  segments: [{ name: "target" }],
};

function decl(file: string, startLine: number, name = "sym"): SymbolOverviewNode {
  return {
    type: "symbol",
    identity: { file, segments: [{ name }] },
    kind: { role: "callable", nativeLabel: "function" },
    range: { startLine, endLine: startLine },
    header: { startLine, lines: [`function ${name}()`] },
    children: [],
  };
}

function edge(file: string, startLine: number, confidence: EdgeConfidence = "certain"): CallEdge {
  return {
    symbol: decl(file, startLine),
    sites: [
      {
        file: "src/target.ts",
        line: 1,
        previewSource: "target()",
        matchStart: 0,
        matchEnd: 6,
      },
    ],
    confidence,
    ...(confidence === "possible" ? { reason: "dynamic dispatch" } : {}),
  };
}

const target = decl("src/target.ts", 1, "target");

function build(overrides: {
  callers?: readonly CallEdge[];
  callees?: readonly CallEdge[];
  references?: readonly SymbolReference[];
  history?: readonly HistoryEntry[];
  cap?: number;
}) {
  return new ContextResultBuilder({
    identity,
    target,
    definitions: [target],
    callerEdgesWithAnyConfidence: overrides.callers ?? [],
    calleeEdgesWithAnyConfidence: overrides.callees ?? [],
    references: overrides.references ?? [],
    history: overrides.history ?? [],
    cap: overrides.cap ?? DEFAULT_CONTEXT_CAP,
  }).build();
}

describe("ContextResultBuilder", () => {
  it("drops possible edges from callers and callees", () => {
    const result = build({
      callers: [edge("src/a.ts", 1, "certain"), edge("src/b.ts", 2, "possible")],
      callees: [edge("src/c.ts", 1, "possible"), edge("src/d.ts", 2, "certain")],
    });
    expect(result.callers.sortedEdges).toHaveLength(1);
    expect(result.callers.sortedEdges[0]!.symbol.identity.file).toBe("src/a.ts");
    expect(result.callees.sortedEdges).toHaveLength(1);
    expect(result.callees.sortedEdges[0]!.symbol.identity.file).toBe("src/d.ts");
  });

  it("caps certain edges and reports omitted certain edges", () => {
    const callees = Array.from({ length: 25 }, (_value, index) =>
      edge(`src/file-${String(index).padStart(2, "0")}.ts`, index + 1),
    );
    const result = build({ callees });
    expect(result.callees.sortedEdges).toHaveLength(20);
    expect(result.callees.omittedCertainEdgeCount).toBe(5);
  });

  it("reports zero omitted certain edges at exactly the cap", () => {
    const callees = Array.from({ length: 20 }, (_value, index) =>
      edge(`src/file-${String(index).padStart(2, "0")}.ts`, index + 1),
    );
    const result = build({ callees });
    expect(result.callees.sortedEdges).toHaveLength(20);
    expect(result.callees.omittedCertainEdgeCount).toBe(0);
  });

  it("sorts edges by file then symbol start line", () => {
    const result = build({
      callees: [edge("src/b.ts", 5), edge("src/a.ts", 9), edge("src/a.ts", 2)],
    });
    expect(
      result.callees.sortedEdges.map((each) => ({
        file: each.symbol.identity.file,
        startLine: each.symbol.range.startLine,
      })),
    ).toEqual([
      { file: "src/a.ts", startLine: 2 },
      { file: "src/a.ts", startLine: 9 },
      { file: "src/b.ts", startLine: 5 },
    ]);
  });

  it("summarises references by total and kind counts", () => {
    const reference = (kind: SymbolReference["kind"]): SymbolReference => ({
      file: "src/a.ts",
      line: 1,
      previewSource: "target",
      matchStart: 0,
      matchEnd: 6,
      kind,
    });
    const result = build({
      references: [reference("usage"), reference("usage"), reference("import"), reference("type")],
    });
    expect(result.references.total).toBe(4);
    expect(result.references.kindCounts).toEqual({ usage: 2, import: 1, export: 0, type: 1 });
  });

  it("passes history through unchanged", () => {
    const history: readonly HistoryEntry[] = [
      { shortSha: "abc1234", isoDate: "2026-06-01", author: "Mo", subject: "init" },
    ];
    const result = build({ history });
    expect(result.history).toEqual(history);
  });
});
