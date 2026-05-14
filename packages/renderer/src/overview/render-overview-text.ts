import type { FileSymbols, LineRange, Signature, SymbolDecl } from "@symnav/core";
import { buildSymbolPath } from "@symnav/core";

import { capSignatureLines } from "./signature-cap.js";

const TREE_BRANCH = "├── ";
const TREE_LAST = "└── ";
const TREE_VERTICAL = "│   ";
const TREE_SPACE = "    ";

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
  const signatureBlock = renderSignature(decl.signature, "");
  const childrenBlock = renderChildren(decl.children, [...ancestors, decl], "");
  return headLine + signatureBlock + childrenBlock;
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
  const signatureBlock = renderSignature(decl.signature, parentPrefix + continuationGlyph);
  const childrenBlock = renderChildren(
    decl.children,
    [...ancestors, decl],
    parentPrefix + continuationGlyph,
  );
  return headLine + signatureBlock + childrenBlock;
}

function renderSignature(signature: Signature, prefix: string): string {
  return capSignatureLines(signature.lines)
    .map((text, index) => `${prefix}${signature.startLine + index}: ${text}\n`)
    .join("");
}

function formatRange(range: LineRange): string {
  if (range.startLine === range.endLine) {
    return `${range.startLine}`;
  }
  return `${range.startLine}-${range.endLine}`;
}
