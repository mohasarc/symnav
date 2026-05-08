import type { FileSymbols, LineRange, SymbolDecl } from "@symnav/core";
import { buildSymbolPath } from "@symnav/core";
import { SIGNATURE_INDENT } from "./tree-glyphs.js";

function formatRange(range: LineRange): string {
  return range.startLine === range.endLine
    ? String(range.startLine)
    : `${range.startLine}-${range.endLine}`;
}

function renderTopLevelBlock(decl: SymbolDecl, ancestors: readonly SymbolDecl[]): string {
  const path = buildSymbolPath(ancestors, decl);
  const header = `${formatRange(decl.range)}: ${path}`;
  const signature = `${SIGNATURE_INDENT}${decl.signature}`;
  return `${header}\n${signature}\n`;
}

export function renderOverviewText(file: FileSymbols): string {
  const header = `Overview: ${file.filePath}\n\n`;
  if (file.symbols.length === 0) {
    return `${header}(no symbols)\n`;
  }
  const blocks = file.symbols.map((decl) => renderTopLevelBlock(decl, []));
  return `${header}${blocks.join("\n")}`;
}
