import type { OverviewFileSymbols } from "../intermediate-representation/types.js";
import type { ResolvedPath } from "../workspace/workspace.js";

export interface ResolveSymbolsOptions {
  readonly fuzzy: boolean;
}

export interface LanguageBackend {
  accepts(filePath: string): boolean;
  fileSymbols(path: ResolvedPath): Promise<OverviewFileSymbols>;
}
