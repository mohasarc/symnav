import type { CallEdge } from "../intermediate-representation/call-edge.js";
import type { CallTargetResolution } from "../intermediate-representation/call-target.js";
import type { SymbolReference } from "../intermediate-representation/references.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import type {
  OverviewFileEntries,
  SymbolOverviewNode,
} from "../intermediate-representation/overview-tree.js";
import type { ResolvedPath, WorkspaceSnapshot } from "../workspace/workspace.js";

export interface BackendRefreshSummary {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly unchanged: number;
}

export type BackendRefreshCoverage = "workspace" | "selection";

export interface BackendRefreshRequest {
  readonly snapshot: WorkspaceSnapshot;
  readonly coverage: BackendRefreshCoverage;
}

export type ResolveSymbolsMode = "exact" | "fuzzy" | "regex";

export type ResolveSymbolsOptions =
  | { readonly mode: "exact" }
  | { readonly mode: "fuzzy" }
  | { readonly mode: "regex"; readonly regex: RegExp };

export interface LanguageBackend {
  accepts(filePath: string): boolean;
  refresh(request: BackendRefreshRequest): Promise<BackendRefreshSummary>;
  releaseTransientResources(): Promise<void>;
  fileEntries(path: ResolvedPath): Promise<OverviewFileEntries>;
  resolveSymbols(
    files: readonly ResolvedPath[],
    query: string,
    options: ResolveSymbolsOptions,
  ): Promise<readonly SymbolOverviewNode[]>;
  declarations(files: readonly ResolvedPath[]): Promise<readonly SymbolOverviewNode[]>;
  findDefinitions(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolOverviewNode[]>;
  findReferences(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolReference[]>;
  findCallTarget(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<CallTargetResolution>;
  findCallees(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]>;
  findCallers(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]>;
}
