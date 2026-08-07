import type { CallEdge } from "../intermediate-representation/call-edge.js";
import type { CallTargetResolution } from "../intermediate-representation/call-target.js";
import type { SymbolReference } from "../intermediate-representation/references.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import type { OverviewFileEntries } from "../intermediate-representation/overview-tree.js";
import type { SymbolOverviewNode } from "../intermediate-representation/overview-tree.js";
import type { ResolvedPath } from "../workspace/workspace.js";

export interface ResolveSymbolsOptions {
  readonly fuzzy: boolean;
}

export interface LanguageBackend {
  accepts(filePath: string): boolean;
  fileEntries(path: ResolvedPath): Promise<OverviewFileEntries>;
  resolveSymbols(
    files: readonly ResolvedPath[],
    query: string,
    options: ResolveSymbolsOptions,
  ): Promise<readonly SymbolOverviewNode[]>;
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
