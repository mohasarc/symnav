import type { DefinitionResult, SymbolDecl } from "@symnav/core";

import { formatIdentityPath, formatRange, treeGlyphsFor } from "../shared/render-format.js";
import { bracketTagFor } from "./definition-tag.js";

export function renderDefinitionText(result: DefinitionResult): string {
  const header = `Definition: ${formatIdentityPath(result.identity)}\n\n`;
  if (result.symbols.length === 0) {
    return `${header}(no matching definitions)\n`;
  }
  return header + renderFileGroups(result.symbols);
}

function renderFileGroups(symbols: readonly SymbolDecl[]): string {
  const groups = groupByFile(symbols);
  return [...groups.entries()].map(([file, group]) => renderFileGroup(file, group)).join("\n");
}

function groupByFile(symbols: readonly SymbolDecl[]): Map<string, SymbolDecl[]> {
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

function renderFileGroup(file: string, symbols: readonly SymbolDecl[]): string {
  const header = `${file}\n`;
  const entries = symbols
    .map((symbol, index) => renderSymbolEntry(symbol, index === symbols.length - 1))
    .join("");
  return header + entries;
}

function renderSymbolEntry(symbol: SymbolDecl, isLast: boolean): string {
  const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
  const tag = bracketTagFor(symbol.kind.nativeLabel);
  const tagSuffix = tag === undefined ? "" : `  [${tag}]`;
  const head = `${branchGlyph}${formatRange(symbol.range)}: ${formatIdentityPath(symbol.identity)}${tagSuffix}\n`;
  const sig = symbol.signature.lines.map((line) => `${continuationGlyph}${line}\n`).join("");
  return head + sig;
}
