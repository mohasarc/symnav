import type { OverviewNode } from "../intermediate-representation/overview-tree.js";
import type { LineRange, ResultWithDiagnostics } from "../intermediate-representation/types.js";

export interface OverviewExpansionRequest {
  readonly depth: number;
  readonly at: string | undefined;
  readonly line: number | undefined;
}

export interface OverviewExpansionCandidate {
  readonly header: string;
  readonly range: LineRange;
  readonly node: OverviewNode;
}

export interface OverviewExpansionResult extends ResultWithDiagnostics {
  readonly file: string;
  readonly entries: readonly OverviewNode[];
  readonly request: OverviewExpansionRequest;
  readonly totalSymbolCount: number;
}
