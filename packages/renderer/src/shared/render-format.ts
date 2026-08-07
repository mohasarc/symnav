import { formatSymbolPath, type LineRange, type SymbolIdentity } from "@symnav/core";

const TREE_BRANCH = "├── ";
const TREE_LAST = "└── ";
const TREE_VERTICAL = "│   ";
const TREE_SPACE = "    ";

export function formatRange(range: LineRange): string {
  if (range.startLine === range.endLine) {
    return `${range.startLine}`;
  }
  return `${range.startLine}-${range.endLine}`;
}

export function formatHeadLine(prefix: string, range: LineRange, path: string): string {
  return `${prefix}${formatRange(range)}: ${path}\n`;
}

export function formatIdentityPath(identity: SymbolIdentity): string {
  return formatSymbolPath(identity.segments);
}

export function treeGlyphsFor(isLast: boolean): {
  branchGlyph: string;
  continuationGlyph: string;
} {
  return {
    branchGlyph: isLast ? TREE_LAST : TREE_BRANCH,
    continuationGlyph: isLast ? TREE_SPACE : TREE_VERTICAL,
  };
}
