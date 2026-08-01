import type { NavigationDiagnostic } from "../diagnostics/navigation-diagnostic.js";
import type { OverviewNode } from "../intermediate-representation/overview-tree.js";
import type { LineRange } from "../intermediate-representation/types.js";

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

export interface OverviewExpansionResult {
  readonly file: string;
  readonly entries: readonly OverviewNode[];
  readonly request: OverviewExpansionRequest;
  readonly diagnostics?: readonly NavigationDiagnostic[];
}
