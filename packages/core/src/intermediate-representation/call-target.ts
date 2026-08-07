import type { SymbolOverviewNode } from "./overview-tree.js";

export type CallTargetResolution =
  | { readonly outcome: "resolved"; readonly target: SymbolOverviewNode }
  | { readonly outcome: "ambiguous"; readonly candidates: readonly SymbolOverviewNode[] }
  | { readonly outcome: "not-found" };
