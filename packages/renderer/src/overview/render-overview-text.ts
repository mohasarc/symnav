import type { FileSymbols, LineRange, SymbolDecl } from "@symnav/core";
import { buildSymbolPath } from "@symnav/core";

import {
  SIGNATURE_INDENT,
  TREE_BRANCH,
  TREE_LAST,
  TREE_SPACE,
  TREE_VERTICAL,
} from "./tree-glyphs.js";
import { capSignature } from "./signature-cap.js";

export function renderOverviewText(file: FileSymbols): string {
  const header = `Overview: ${file.filePath}\n\n`;
  if (file.symbols.length === 0) {
    return `${header}(no symbols)\n`;
  }

  const blocks = file.symbols.map((decl) => renderTopLevel(decl, []));
  return header + blocks.join("\n");
}

function renderTopLevel(decl: SymbolDecl, ancestors: readonly SymbolDecl[]): string {
  const headLine = `${formatRange(decl.range)}: ${buildSymbolPath(ancestors, decl)}\n`;
  const signatureLine = `${SIGNATURE_INDENT}${capSignature(decl.signatureSource)}\n`;
  const childrenBlock = renderChildren(decl.children, [...ancestors, decl], "");
  return headLine + signatureLine + childrenBlock;
}

function renderChildren(
  children: readonly SymbolDecl[],
  ancestors: readonly SymbolDecl[],
  parentPrefix: string,
): string {
  return children
    .map((child, index) => {
      const isLast = index === children.length - 1;
      return renderChild(child, ancestors, parentPrefix, isLast);
    })
    .join("");
}

function renderChild(
  decl: SymbolDecl,
  ancestors: readonly SymbolDecl[],
  parentPrefix: string,
  isLast: boolean,
): string {
  const branchGlyph = isLast ? TREE_LAST : TREE_BRANCH;
  const continuationGlyph = isLast ? TREE_SPACE : TREE_VERTICAL;

  const headLine = `${parentPrefix}${branchGlyph}${formatRange(decl.range)}: ${buildSymbolPath(ancestors, decl)}\n`;
  const signatureLine = `${parentPrefix}${continuationGlyph}${capSignature(decl.signatureSource)}\n`;
  const childrenBlock = renderChildren(
    decl.children,
    [...ancestors, decl],
    parentPrefix + continuationGlyph,
  );
  return headLine + signatureLine + childrenBlock;
}

function formatRange(range: LineRange): string {
  if (range.startLine === range.endLine) {
    return `${range.startLine}`;
  }
  return `${range.startLine}-${range.endLine}`;
}
