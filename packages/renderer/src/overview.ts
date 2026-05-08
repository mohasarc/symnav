import { buildSymbolPath, type FileSymbols, type LineRange, type SymbolDecl } from "@symnav/core";
import {
  SIGNATURE_INDENT,
  TREE_BRANCH,
  TREE_LAST,
  TREE_SPACE,
  TREE_VERTICAL,
} from "./tree-glyphs.js";

export function renderOverviewText(file: FileSymbols): string {
  const lines: string[] = [`Overview: ${file.filePath}`, ""];

  if (file.symbols.length === 0) {
    lines.push("(no symbols)");
    return lines.join("\n") + "\n";
  }

  for (let i = 0; i < file.symbols.length; i++) {
    if (i > 0) lines.push("");
    appendDecl(lines, file.symbols[i]!, [], "", true, true);
  }

  return lines.join("\n") + "\n";
}

function appendDecl(
  lines: string[],
  decl: SymbolDecl,
  ancestors: readonly SymbolDecl[],
  parentPrefix: string,
  isTopLevel: boolean,
  isLast: boolean,
): void {
  const symbolPath = buildSymbolPath(ancestors, decl);
  const headerPrefix = isTopLevel ? "" : `${parentPrefix}${isLast ? TREE_LAST : TREE_BRANCH}`;
  const sigPrefix = isTopLevel
    ? SIGNATURE_INDENT
    : `${parentPrefix}${isLast ? TREE_SPACE : TREE_VERTICAL}`;

  lines.push(`${headerPrefix}${formatRange(decl.range)}: ${symbolPath}`);
  lines.push(`${sigPrefix}${decl.signature}`);

  const childAncestors = [...ancestors, decl];
  const childPrefix = isTopLevel ? "" : `${parentPrefix}${isLast ? TREE_SPACE : TREE_VERTICAL}`;
  for (let i = 0; i < decl.children.length; i++) {
    appendDecl(
      lines,
      decl.children[i]!,
      childAncestors,
      childPrefix,
      false,
      i === decl.children.length - 1,
    );
  }
}

function formatRange(range: LineRange): string {
  return range.startLine === range.endLine
    ? String(range.startLine)
    : `${range.startLine}-${range.endLine}`;
}

export function renderOverviewJson(file: FileSymbols): string {
  return JSON.stringify(toPlain(file), sortKeys, 2) + "\n";
}

function toPlain(file: FileSymbols): unknown {
  return {
    filePath: file.filePath,
    symbols: file.symbols.map(declToPlain),
  };
}

function declToPlain(decl: SymbolDecl): unknown {
  return {
    kind: decl.kind,
    name: decl.name,
    range: { startLine: decl.range.startLine, endLine: decl.range.endLine },
    signature: decl.signature,
    children: decl.children.map(declToPlain),
  };
}

function sortKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const ordered: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      ordered[k] = (value as Record<string, unknown>)[k];
    }
    return ordered;
  }
  return value;
}
