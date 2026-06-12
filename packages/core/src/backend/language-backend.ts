import type { Reference } from "../intermediate-representation/references.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import type { OverviewFileSymbols, SymbolDecl } from "../intermediate-representation/types.js";
import type { ResolvedPath } from "../workspace/workspace.js";

export interface ResolveSymbolsOptions {
  readonly fuzzy: boolean;
}

export interface LanguageBackend {
  accepts(filePath: string): boolean;
  fileSymbols(path: ResolvedPath): Promise<OverviewFileSymbols>;
  resolveSymbols(
    files: readonly ResolvedPath[],
    query: string,
    options: ResolveSymbolsOptions,
  ): Promise<readonly SymbolDecl[]>;
  findDefinitions(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolDecl[]>;
  findReferences(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly Reference[]>;
}
