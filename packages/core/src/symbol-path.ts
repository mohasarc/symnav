import type { SymbolDecl } from "./ir.js";

/**
 * Compose a symbol path from an ancestor chain plus a leaf decl.
 * `ancestors` is ordered outer-to-inner (file's top-level first).
 * Result: ancestor names + leaf name, joined by "::".
 */
export function buildSymbolPath(ancestors: readonly SymbolDecl[], decl: SymbolDecl): string {
  if (ancestors.length === 0) {
    return decl.name;
  }
  const names = ancestors.map((a) => a.name);
  names.push(decl.name);
  return names.join("::");
}
