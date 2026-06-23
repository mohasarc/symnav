import type { SymbolDecl } from "./types.js";

export type CallTargetResolution =
  | { readonly outcome: "resolved"; readonly target: SymbolDecl }
  | { readonly outcome: "ambiguous"; readonly candidates: readonly SymbolDecl[] }
  | { readonly outcome: "not-found" };
