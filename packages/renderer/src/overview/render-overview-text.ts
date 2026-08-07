import type { Header, OverviewFileEntries, OverviewNode } from "@symnav/core";

import { formatHeadLine, formatIdentityPath, treeGlyphsFor } from "../shared/render-format.js";
import { formatEmptyOverview, formatOverviewHeader, formatHeaderLine } from "./overview-format.js";
import { capHeaderLineLength, capHeaderLines } from "./header-cap.js";

const TOP_LEVEL_SEPARATOR = "│\n";

export function renderOverviewText(file: OverviewFileEntries): string {
  if (file.entries.length === 0) {
    return formatEmptyOverview(file.file);
  }
  return formatOverviewHeader(file.file) + renderTopLevelChildren(file.entries);
}

function renderTopLevelChildren(children: readonly OverviewNode[]): string {
  return children
    .map((child, index) => renderChild(child, "", index === children.length - 1))
    .join(TOP_LEVEL_SEPARATOR);
}

function renderChildren(children: readonly OverviewNode[], parentPrefix: string): string {
  return children
    .map((child, index) => renderChild(child, parentPrefix, index === children.length - 1))
    .join("");
}

function renderChild(node: OverviewNode, parentPrefix: string, isLast: boolean): string {
  const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
  const headLine = formatHeadLine(parentPrefix + branchGlyph, node.range, overviewNodeLabel(node));
  const childPrefix = parentPrefix + continuationGlyph;
  const headerBlock =
    node.type === "symbol"
      ? renderHeader(node.header, childPrefix)
      : renderHeaderContinuation(node.header, childPrefix);
  const childrenBlock = node.type === "re-export" ? "" : renderChildren(node.children, childPrefix);
  return headLine + headerBlock + childrenBlock;
}

function renderHeader(header: Header, prefix: string): string {
  return formattedHeaderLines(header, prefix).join("");
}

function renderHeaderContinuation(header: Header, prefix: string): string {
  return formattedHeaderLines(lengthCappedHeader(header), prefix).slice(1).join("");
}

function lengthCappedHeader(header: Header): Header {
  return { startLine: header.startLine, lines: header.lines.map(capHeaderLineLength) };
}

function formattedHeaderLines(header: Header, prefix: string): readonly string[] {
  return capHeaderLines(header.lines).map((text, index) =>
    formatHeaderLine(prefix, header.startLine + index, text),
  );
}

function overviewNodeLabel(node: OverviewNode): string {
  if (node.type === "symbol") return formatIdentityPath(node.identity);
  return capHeaderLineLength(node.header.lines[0] ?? "");
}
