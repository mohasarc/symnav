import type { SymbolOverviewNode } from "@symnav/core";

export function groupByFile<Symbol extends SymbolOverviewNode>(
  symbols: readonly Symbol[],
): Map<string, Symbol[]> {
  const map = new Map<string, Symbol[]>();
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
