import type { SymbolDecl } from "./ir.js";

export function buildSymbolPath(ancestors: readonly SymbolDecl[], decl: SymbolDecl): string {
  return [...ancestors.map((a) => a.name), decl.name].join("::");
}
