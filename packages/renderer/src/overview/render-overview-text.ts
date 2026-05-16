import type { FileSymbols, Signature, SymbolDecl } from "@symnav/core";
import { buildSymbolPath } from "@symnav/core";

import {
  formatEmptyOverview,
  formatHeadLine,
  formatOverviewHeader,
  formatSignatureLine,
  treeGlyphsFor,
} from "./overview-format.js";
import { capSignatureLines } from "./signature-cap.js";

export function renderOverviewText(file: FileSymbols): string {
  if (file.symbols.length === 0) {
    return formatEmptyOverview(file.filePath);
  }
  return formatOverviewHeader(file.filePath) + renderChildren(file.symbols, [], "");
}

function renderChildren(
  children: readonly SymbolDecl[],
  ancestors: readonly SymbolDecl[],
  parentPrefix: string,
): string {
  return children
    .map((child, index) =>
      renderChild(child, ancestors, parentPrefix, index === children.length - 1),
    )
    .join("");
}

function renderChild(
  decl: SymbolDecl,
  ancestors: readonly SymbolDecl[],
  parentPrefix: string,
  isLast: boolean,
): string {
  const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
  const headLine = formatHeadLine(
    parentPrefix + branchGlyph,
    decl.range,
    buildSymbolPath(ancestors, decl),
  );
  const childPrefix = parentPrefix + continuationGlyph;
  const signatureBlock = renderSignature(decl.signature, childPrefix);
  const childrenBlock = renderChildren(decl.children, [...ancestors, decl], childPrefix);
  return headLine + signatureBlock + childrenBlock;
}

function renderSignature(signature: Signature, prefix: string): string {
  return capSignatureLines(signature.lines)
    .map((text, index) => formatSignatureLine(prefix, signature.startLine + index, text))
    .join("");
}
