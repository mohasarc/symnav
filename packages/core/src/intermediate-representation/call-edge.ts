import type { SymbolDecl } from "./types.js";
import type { SourceMatch } from "./source-match.js";

export type EdgeConfidence = "certain" | "possible";

export type CallSite = SourceMatch;

export interface CallEdge {
  readonly symbol: SymbolDecl; // the callee (this phase) or caller (Phase 3)
  readonly sites: readonly CallSite[]; // >= 1, sorted by file then line
  readonly confidence: EdgeConfidence;
  readonly reason?: string; // set when confidence === "possible"
}
