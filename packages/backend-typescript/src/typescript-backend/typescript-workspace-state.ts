import type { ResolvedPath, SymbolOverviewNode } from "@symnav/core";

export interface IndexedDeclaration {
  readonly declaration: SymbolOverviewNode;
  readonly file: ResolvedPath;
}
