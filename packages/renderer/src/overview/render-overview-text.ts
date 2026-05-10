import type { FileSymbols, LineRange, SymbolDecl } from "@symnav/core";
import { buildSymbolPath } from "@symnav/core";

import { SIGNATURE_INDENT } from "./tree-glyphs.js";
import { capSignature } from "./signature-cap.js";

export function renderOverviewText(file: FileSymbols): string {
  const header = `Overview: ${file.filePath}\n\n`;
  if (file.symbols.length === 0) {
    return `${header}(no symbols)\n`;
  }

  const blocks = file.symbols.map((decl) => renderTopLevel(decl));
  return header + blocks.join("\n");
}

function renderTopLevel(decl: SymbolDecl): string {
  const headLine = `${formatRange(decl.range)}: ${buildSymbolPath([], decl)}\n`;
  const signatureLine = `${SIGNATURE_INDENT}${capSignature(decl.signatureSource)}\n`;
  return headLine + signatureLine;
}

function formatRange(range: LineRange): string {
  if (range.startLine === range.endLine) {
    return `${range.startLine}`;
  }
  return `${range.startLine}-${range.endLine}`;
}
