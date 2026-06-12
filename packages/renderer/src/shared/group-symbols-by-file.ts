import type { SymbolDecl } from "@symnav/core";

export function groupByFile(symbols: readonly SymbolDecl[]): Map<string, SymbolDecl[]> {
  const map = new Map<string, SymbolDecl[]>();
  for (const symbol of symbols) {
    const file = symbol.identity.file;
    const bucket = map.get(file);
    if (bucket) {
      bucket.push(symbol);
    } else {
      map.set(file, [symbol]);
    }
  }
  return map;
}
