import type { SymbolDecl } from "./ir.js";

export function buildSymbolPath(ancestors: readonly SymbolDecl[], decl: SymbolDecl): string {
  if (ancestors.length === 0) {
    return decl.name;
  }
  const names = ancestors.map((a) => a.name);
  names.push(decl.name);
  return names.join("::");
}
