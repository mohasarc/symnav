import { OverviewTree } from "@symnav/core";
import type { OverviewFileEntries, Header, SymbolOverviewNode } from "@symnav/core";

import { formatHeadLine, formatIdentityPath, treeGlyphsFor } from "../shared/render-format.js";
import { formatEmptyOverview, formatOverviewHeader, formatHeaderLine } from "./overview-format.js";
import { capHeaderLines } from "./header-cap.js";

const TOP_LEVEL_SEPARATOR = "│\n";

export function renderOverviewText(file: OverviewFileEntries): string {
  if (file.entries.length === 0) {
    return formatEmptyOverview(file.file);
  }
  return (
    formatOverviewHeader(file.file) +
    renderTopLevelChildren(OverviewTree.scopeSymbols(file.entries))
  );
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
  const headerBlock = renderHeader(decl.header, childPrefix);
  const childrenBlock = renderChildren(OverviewTree.scopeSymbols(decl.children), childPrefix);
  return headLine + headerBlock + childrenBlock;
}

function renderHeader(header: Header, prefix: string): string {
  return capHeaderLines(header.lines)
    .map((text, index) => formatHeaderLine(prefix, header.startLine + index, text))
    .join("");
}
