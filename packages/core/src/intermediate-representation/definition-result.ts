import type { SymbolIdentity } from "./symbol-identity.js";
import type { SymbolDecl } from "./types.js";

export interface DefinitionResult {
  readonly identity: SymbolIdentity;
  readonly symbols: readonly SymbolDecl[];
}
