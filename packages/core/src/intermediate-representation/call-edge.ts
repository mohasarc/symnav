import type { SymbolOverviewNode } from "./overview-tree.js";
import type { SourceMatch } from "./source-match.js";

export type EdgeConfidence = "certain" | "possible";

export type CallSite = SourceMatch;

export interface CallEdge {
  readonly symbol: SymbolOverviewNode; // the callee (this phase) or caller (Phase 3)
  readonly sites: readonly CallSite[]; // >= 1, sorted by file then line
  readonly confidence: EdgeConfidence;
  readonly reason?: string; // set when confidence === "possible"
}
