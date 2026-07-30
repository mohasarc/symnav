import type { HistoryEntry } from "../git/git-history.js";
import type { CallEdge } from "./call-edge.js";
import type { CappedCertainCallEdges, ContextResult } from "./context-result.js";
import { countReferenceKinds } from "./reference-kinds.js";
import type { SymbolReference } from "./references.js";
import type { SymbolIdentity } from "./symbol-identity.js";
import type { SymbolOverviewNode } from "./overview-tree.js";

export interface BuildContextResultArgs {
  readonly identity: SymbolIdentity;
  readonly target: SymbolOverviewNode;
  readonly definitions: readonly SymbolOverviewNode[];
  readonly callerEdgesWithAnyConfidence: readonly CallEdge[];
  readonly calleeEdgesWithAnyConfidence: readonly CallEdge[];
  readonly references: readonly SymbolReference[];
  readonly history: readonly HistoryEntry[];
  readonly cap: number;
}

export class ContextResultBuilder {
  constructor(private readonly args: BuildContextResultArgs) {}

  build(): ContextResult {
    return {
      identity: this.args.identity,
      target: this.args.target,
      definitions: this.args.definitions,
      callers: this.capEdges(this.args.callerEdgesWithAnyConfidence),
      callees: this.capEdges(this.args.calleeEdgesWithAnyConfidence),
      references: {
        total: this.args.references.length,
        kindCounts: countReferenceKinds(this.args.references),
      },
      history: this.args.history,
    };
  }

  private capEdges(edges: readonly CallEdge[]): CappedCertainCallEdges {
    const certain = edges
      .filter((edge) => edge.confidence === "certain")
      .sort(ContextResultBuilder.compareEdges);
    return {
      sortedEdges: certain.slice(0, this.args.cap),
      omittedCertainEdgeCount: Math.max(certain.length - this.args.cap, 0),
    };
  }

  private static compareEdges(left: CallEdge, right: CallEdge): number {
    if (left.symbol.identity.file !== right.symbol.identity.file) {
      return left.symbol.identity.file < right.symbol.identity.file ? -1 : 1;
    }
    return left.symbol.range.startLine - right.symbol.range.startLine;
  }
}
