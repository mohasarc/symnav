import type { GraphPath } from "../graph/graph-path.js";
import type { SymbolIdentity } from "./symbol-identity.js";
import type { SymbolOverviewNode } from "./overview-tree.js";
import type { ResultWithDiagnostics } from "./types.js";

export type GraphDirection = "incoming" | "outgoing" | "both";

export interface GraphDirectionPage {
  readonly paths: readonly GraphPath[];
  readonly totalPathCount: number;
}

export interface GraphResult extends ResultWithDiagnostics {
  readonly identity: SymbolIdentity;
  readonly root: SymbolOverviewNode;
  readonly depth: number;
  readonly direction: GraphDirection;
  readonly incoming?: GraphDirectionPage;
  readonly outgoing?: GraphDirectionPage;
  readonly page: number;
  readonly pageCount: number;
  readonly repeatedSymbolCount: number;
}
