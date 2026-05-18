import type { OverviewFileSymbols } from "../intermediate-representation/types.js";
import type { ResolvedPath } from "../workspace/workspace.js";

export interface LanguageBackend {
  accepts(filePath: string): boolean;
  fileSymbols(path: ResolvedPath): Promise<OverviewFileSymbols>;
}
