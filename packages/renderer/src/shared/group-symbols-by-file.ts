import type { SymbolOverviewNode } from "@symnav/core";

export function groupByFile<GroupedSymbol extends SymbolOverviewNode>(
  symbols: readonly GroupedSymbol[],
): Map<string, GroupedSymbol[]> {
  const map = new Map<string, GroupedSymbol[]>();
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
