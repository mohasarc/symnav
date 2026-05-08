import type { FileSymbols, LineRange, SymbolDecl } from "@symnav/core";
import { buildSymbolPath } from "@symnav/core";
import {
  SIGNATURE_INDENT,
  TREE_BRANCH,
  TREE_LAST,
  TREE_SPACE,
  TREE_VERTICAL,
} from "./tree-glyphs.js";

function formatRange(range: LineRange): string {
  return range.startLine === range.endLine
    ? String(range.startLine)
    : `${range.startLine}-${range.endLine}`;
}

function renderChildren(
  children: readonly SymbolDecl[],
  ancestors: readonly SymbolDecl[],
  prefix: string,
): string {
  let out = "";
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const isLast = i === children.length - 1;
    const branch = isLast ? TREE_LAST : TREE_BRANCH;
    const continuation = isLast ? TREE_SPACE : TREE_VERTICAL;
    const path = buildSymbolPath(ancestors, child);
    out += `${prefix}${branch}${formatRange(child.range)}: ${path}\n`;
    out += `${prefix}${continuation}${child.signature}\n`;
    if (child.children.length > 0) {
      out += renderChildren(child.children, [...ancestors, child], prefix + continuation);
    }
  }
  return out;
}

function renderTopLevel(decl: SymbolDecl): string {
  const path = buildSymbolPath([], decl);
  let block = `${formatRange(decl.range)}: ${path}\n`;
  block += `${SIGNATURE_INDENT}${decl.signature}\n`;
  if (decl.children.length > 0) {
    block += renderChildren(decl.children, [decl], "");
  }
  return block;
}

export function renderOverviewText(file: FileSymbols): string {
  const header = `Overview: ${file.filePath}\n\n`;
  if (file.symbols.length === 0) {
    return `${header}(no symbols)\n`;
  }
  const blocks = file.symbols.map(renderTopLevel);
  return `${header}${blocks.join("\n")}`;
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(source).sort()) {
      sorted[k] = source[k];
    }
    return sorted;
  }
  return value;
}

export function renderOverviewJson(file: FileSymbols): string {
  return `${JSON.stringify(file, sortKeysReplacer, 2)}\n`;
}
