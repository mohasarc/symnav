import type { LineRange, SymbolIdentity, SymbolPathSegment } from "@symnav/core";

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
  return identity.segments.map(formatIdentitySegment).join("::");
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

function formatIdentitySegment(segment: SymbolPathSegment): string {
  if (segment.disambiguator === undefined) {
    return segment.name;
  }
  return `${segment.name}#${segment.disambiguator}`;
}
