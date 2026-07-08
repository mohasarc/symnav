import type { CallEdge } from "../intermediate-representation/call-edge.js";
import type { CallTargetResolution } from "../intermediate-representation/call-target.js";
import type { SymbolReference } from "../intermediate-representation/references.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import type {
  OverviewFileEntries,
  SymbolOverviewNode,
} from "../intermediate-representation/overview-tree.js";
import type { SymbolTargetPattern } from "../target/symbol-target-pattern.js";
import type { SymbolTargetCandidate } from "../target/symbol-target-result.js";
import type { ResolvedPath } from "../workspace/workspace.js";

export type ResolveSymbolsMode = "exact" | "fuzzy" | "regex";

export interface ResolveSymbolsOptions {
  readonly mode: ResolveSymbolsMode;
}

export interface ResolveSymbolTargetOptions {
  readonly containingLine: number | undefined;
}

export interface LanguageBackend {
  accepts(filePath: string): boolean;
  fileEntries(path: ResolvedPath): Promise<OverviewFileEntries>;
  resolveSymbols(
    files: readonly ResolvedPath[],
    query: string,
    options: ResolveSymbolsOptions,
  ): Promise<readonly SymbolOverviewNode[]>;
  findTargetCandidates(
    files: readonly ResolvedPath[],
    pattern: SymbolTargetPattern,
    options: ResolveSymbolTargetOptions,
  ): Promise<readonly SymbolTargetCandidate[]>;
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
