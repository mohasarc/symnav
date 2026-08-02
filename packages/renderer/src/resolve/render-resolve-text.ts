import type { ResolveResult, SymbolOverviewNode } from "@symnav/core";

import { groupByFile } from "../shared/group-symbols-by-file.js";
import { formatHeadLine, formatIdentityPath, treeGlyphsFor } from "../shared/render-format.js";

export function renderResolveText(result: ResolveResult): string {
  return (
    `Resolve: ${result.query} (${result.mode})\n` +
    "\n" +
    renderSymbolsSection(result.symbols) +
    "\n" +
    renderFilesSection(result.files)
  );
}

function renderSymbolsSection(symbols: readonly SymbolOverviewNode[]): string {
  if (symbols.length === 0) {
    return "Symbols\n(none)\n";
  }
  const byFile = groupByFile(symbols);
  const files = [...byFile.keys()];
  return (
    "Symbols\n" +
    files
      .map((file, index) =>
        renderFileGroup(file, byFile.get(file) ?? [], index === files.length - 1),
      )
      .join("")
  );
}

function renderFilesSection(files: readonly string[]): string {
  if (files.length === 0) {
    return "Files\n(none)\n";
  }
  return (
    "Files\n" +
    files
      .map((file, index) => {
        const { branchGlyph } = treeGlyphsFor(index === files.length - 1);
        return `${branchGlyph}${file}\n`;
      })
      .join("")
  );
}

function renderFileGroup(
  file: string,
  symbols: readonly SymbolOverviewNode[],
  isLastFile: boolean,
): string {
  const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLastFile);
  const header = `${branchGlyph}${file}\n`;
  const childLines = symbols
    .map((symbol, index) =>
      renderSymbolEntry(symbol, continuationGlyph, index === symbols.length - 1),
    )
    .join("");
  return header + childLines;
}

function renderSymbolEntry(
  symbol: SymbolOverviewNode,
  parentPrefix: string,
  isLast: boolean,
): string {
  const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
  const head = formatHeadLine(
    parentPrefix + branchGlyph,
    symbol.range,
    formatIdentityPath(symbol.identity),
  );
  const signaturePrefix = parentPrefix + continuationGlyph;
  const sig = symbol.header.lines.map((line) => `${signaturePrefix}${line}\n`).join("");
  return head + sig;
}
