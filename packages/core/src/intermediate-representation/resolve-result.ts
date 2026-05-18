import type { SymbolDecl } from "./types.js";

export interface ResolveResult {
  readonly query: string;
  readonly fuzzy: boolean;
  readonly symbols: readonly SymbolDecl[];
  readonly files: readonly string[];
}
