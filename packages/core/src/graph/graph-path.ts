import type { EdgeConfidence } from "../intermediate-representation/call-edge.js";
import type { SymbolOverviewNode } from "../intermediate-representation/overview-tree.js";

export interface GraphPathStep {
  readonly symbol: SymbolOverviewNode;
  readonly confidence: EdgeConfidence;
  readonly reason?: string;
  readonly closesCycle: boolean;
}

export interface GraphPath {
  readonly steps: readonly GraphPathStep[];
}

export const DEFAULT_GRAPH_DEPTH = 1;
export const MAX_GRAPH_DEPTH = 5;
