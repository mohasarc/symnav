import type { SymbolOverviewNode } from "@symnav/core";

export function groupByFile(
  symbols: readonly SymbolOverviewNode[],
): Map<string, SymbolOverviewNode[]> {
  const map = new Map<string, SymbolOverviewNode[]>();
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
