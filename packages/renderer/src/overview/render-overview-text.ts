import type { OverviewFileSymbols, Signature, SymbolDecl, SymbolIdentity } from "@symnav/core";

import {
  formatEmptyOverview,
  formatHeadLine,
  formatOverviewHeader,
  formatSignatureLine,
  treeGlyphsFor,
} from "./overview-format.js";
import { capSignatureLines } from "./signature-cap.js";

const TOP_LEVEL_SEPARATOR = "│\n";

export function renderOverviewText(file: OverviewFileSymbols): string {
  if (file.symbols.length === 0) {
    return formatEmptyOverview(file.file);
  }
  return formatOverviewHeader(file.file) + renderTopLevelChildren(file.symbols);
}

function renderTopLevelChildren(children: readonly SymbolDecl[]): string {
  return children
    .map((child, index) => renderChild(child, "", index === children.length - 1))
    .join(TOP_LEVEL_SEPARATOR);
}

function renderChildren(children: readonly SymbolDecl[], parentPrefix: string): string {
  return children
    .map((child, index) => renderChild(child, parentPrefix, index === children.length - 1))
    .join("");
}

function renderChild(decl: SymbolDecl, parentPrefix: string, isLast: boolean): string {
  const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
  const headLine = formatHeadLine(
    parentPrefix + branchGlyph,
    decl.range,
    formatIdentityPath(decl.identity),
  );
  const childPrefix = parentPrefix + continuationGlyph;
  const signatureBlock = renderSignature(decl.signature, childPrefix);
  const childrenBlock = renderChildren(decl.children, childPrefix);
  return headLine + signatureBlock + childrenBlock;
}

function formatIdentityPath(identity: SymbolIdentity): string {
  return identity.segments.map((segment) => segment.name).join("::");
}

function renderSignature(signature: Signature, prefix: string): string {
  return capSignatureLines(signature.lines)
    .map((text, index) => formatSignatureLine(prefix, signature.startLine + index, text))
    .join("");
}
