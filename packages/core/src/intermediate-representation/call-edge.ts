import type { SymbolDecl } from "./types.js";

export type EdgeConfidence = "certain" | "possible";

export interface CallSite {
  readonly file: string; // workspace-relative, POSIX
  readonly line: number; // 1-based
  readonly previewSource: string; // full source line
  readonly matchStart: number;
  readonly matchEnd: number;
}

export interface CallEdge {
  readonly symbol: SymbolDecl; // the callee (this phase) or caller (Phase 3)
  readonly sites: readonly CallSite[]; // >= 1, sorted by file then line
  readonly confidence: EdgeConfidence;
  readonly reason?: string; // set when confidence === "possible"
}
