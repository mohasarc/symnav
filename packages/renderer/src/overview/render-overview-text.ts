import type {
  OverviewFileSymbols,
  OverviewNode,
  Signature,
  SymbolOverviewNode,
} from "@symnav/core";

import { formatHeadLine, formatIdentityPath, treeGlyphsFor } from "../shared/render-format.js";
import {
  formatEmptyOverview,
  formatOverviewHeader,
  formatSignatureLine,
} from "./overview-format.js";
import { capSignatureLines } from "./signature-cap.js";

const TOP_LEVEL_SEPARATOR = "│\n";

export function renderOverviewText(file: OverviewFileSymbols): string {
  if (file.entries.length === 0) {
    return formatEmptyOverview(file.file);
  }
  return formatOverviewHeader(file.file) + renderTopLevelChildren(symbolNodes(file.entries));
}

function renderTopLevelChildren(children: readonly SymbolOverviewNode[]): string {
  return children
    .map((child, index) => renderChild(child, "", index === children.length - 1))
    .join(TOP_LEVEL_SEPARATOR);
}

function renderChildren(children: readonly SymbolOverviewNode[], parentPrefix: string): string {
  return children
    .map((child, index) => renderChild(child, parentPrefix, index === children.length - 1))
    .join("");
}

function renderChild(decl: SymbolOverviewNode, parentPrefix: string, isLast: boolean): string {
  const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
  const headLine = formatHeadLine(
    parentPrefix + branchGlyph,
    decl.range,
    formatIdentityPath(decl.identity),
  );
  const childPrefix = parentPrefix + continuationGlyph;
  const signatureBlock = renderSignature(decl.header, childPrefix);
  const childrenBlock = renderChildren(symbolNodes(decl.children), childPrefix);
  return headLine + signatureBlock + childrenBlock;
}

function renderSignature(header: Signature, prefix: string): string {
  return capSignatureLines(header.lines)
    .map((text, index) => formatSignatureLine(prefix, header.startLine + index, text))
    .join("");
}

function symbolNodes(nodes: readonly OverviewNode[]): readonly SymbolOverviewNode[] {
  return nodes.filter((node): node is SymbolOverviewNode => node.type === "symbol");
}
