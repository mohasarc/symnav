import type { HistoryEntry } from "../git/git-history.js";
import type { CallEdge } from "./call-edge.js";
import type { ReferenceKind } from "./references.js";
import type { SymbolIdentity } from "./symbol-identity.js";
import type { SymbolDecl } from "./types.js";

export const DEFAULT_CONTEXT_CAP = 20;

export interface CappedCallEdges {
  readonly edges: readonly CallEdge[]; // certain only, sorted, <= cap
  readonly overflow: number; // certain edges beyond the cap
}

export interface ContextReferenceSummary {
  readonly total: number;
  readonly kindCounts: Readonly<Record<ReferenceKind, number>>;
}

export interface ContextResult {
  readonly identity: SymbolIdentity;
  readonly target: SymbolDecl;
  readonly definitions: readonly SymbolDecl[];
  readonly callers: CappedCallEdges;
  readonly callees: CappedCallEdges;
  readonly references: ContextReferenceSummary;
  readonly history: readonly HistoryEntry[];
}
