import type {
  CallEdge,
  CappedCallEdges,
  ContextReferenceSummary,
  ContextResult,
  HistoryEntry,
  ReferenceKind,
  SymbolDecl,
} from "@symnav/core";
import { formatSymbolIdentity } from "@symnav/core";

import { groupByFile } from "../shared/group-symbols-by-file.js";
import { formatIdentityPath, formatRange, treeGlyphsFor } from "../shared/render-format.js";
import { bracketTagFor } from "../definition/definition-tag.js";
import type { CallEdgeTreeNode } from "./call-edge-tree.js";
import { buildCallEdgeTree } from "./call-edge-tree.js";

const KIND_ORDER: readonly ReferenceKind[] = ["usage", "import", "export", "type"];
const NONE = "(none)\n";

type PreviewLinesFor = (edge: CallEdge) => readonly string[];

export function renderContextText(result: ContextResult): string {
  const head =
    `Context: ${formatIdentityPath(result.identity)}\n` +
    `File: ${result.identity.file}\n` +
    `Lines: ${formatRange(result.target.range)}\n`;
  const id = formatSymbolIdentity(result.identity);
  const sections = [
    renderDefinition(result.definitions),
    renderEdges(
      "Callers",
      result.callers,
      callerPreview,
      overflowLine("callers", "--incoming", id),
    ),
    renderEdges(
      "Callees",
      result.callees,
      calleePreview,
      overflowLine("callees", "--outgoing", id),
    ),
    renderReferences(result.references, id),
    renderHistory(result.history),
  ];
  return [head, ...sections].join("\n");
}

function renderDefinition(definitions: readonly SymbolDecl[]): string {
  if (definitions.length === 0) {
    return `Definition\n${NONE}`;
  }
  const groups = [...groupByFile(definitions).entries()]
    .map(([file, symbols]) => renderDefinitionFileGroup(file, symbols))
    .join("");
  return `Definition\n${groups}`;
}

function renderDefinitionFileGroup(file: string, symbols: readonly SymbolDecl[]): string {
  const entries = symbols
    .map((symbol, index) => renderDefinitionEntry(symbol, index === symbols.length - 1))
    .join("");
  return `${file}\n${entries}`;
}

function renderDefinitionEntry(symbol: SymbolDecl, isLast: boolean): string {
  const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
  const tag = bracketTagFor(symbol.kind.nativeLabel);
  const tagSuffix = tag === undefined ? "" : `  [${tag}]`;
  const head = `${branchGlyph}${formatRange(symbol.range)}: ${formatIdentityPath(symbol.identity)}${tagSuffix}\n`;
  const signature = symbol.signature.lines.map((line) => `${continuationGlyph}${line}\n`).join("");
  return head + signature;
}

function renderEdges(
  header: string,
  capped: CappedCallEdges,
  previewLinesFor: PreviewLinesFor,
  overflow: string,
): string {
  if (capped.edges.length === 0 && capped.overflow === 0) {
    return `${header}\n${NONE}`;
  }
  const tree = buildCallEdgeTree(capped.edges)
    .map((node) => renderRootNode(node, previewLinesFor))
    .join("");
  const overflowSuffix = capped.overflow === 0 ? "" : overflow.replace("{N}", `${capped.overflow}`);
  return `${header}\n${tree}${overflowSuffix}`;
}

function overflowLine(noun: string, direction: string, id: string): string {
  return `… {N} more ${noun}. Run: symnav graph ${id} ${direction}\n`;
}

function renderRootNode(node: CallEdgeTreeNode, previewLinesFor: PreviewLinesFor): string {
  return `${node.subpath}\n` + renderChildren(node, "", previewLinesFor);
}

function renderChildren(
  node: CallEdgeTreeNode,
  prefix: string,
  previewLinesFor: PreviewLinesFor,
): string {
  if ("edges" in node) {
    return node.edges
      .map((edge, index) =>
        renderEdgeEntry(edge, prefix, index === node.edges.length - 1, previewLinesFor),
      )
      .join("");
  }
  return node.children
    .map((child, index) => {
      const isLast = index === node.children.length - 1;
      const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
      const subpathLine = `${prefix}${branchGlyph}${child.subpath}\n`;
      return subpathLine + renderChildren(child, prefix + continuationGlyph, previewLinesFor);
    })
    .join("");
}

function renderEdgeEntry(
  edge: CallEdge,
  prefix: string,
  isLast: boolean,
  previewLinesFor: PreviewLinesFor,
): string {
  const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
  const tag = edge.sites.length === 1 ? "call" : `call ×${edge.sites.length}`;
  const head = `${prefix}${branchGlyph}${formatRange(edge.symbol.range)}: ${formatIdentityPath(edge.symbol.identity)}  [${tag}]\n`;
  const preview = previewLinesFor(edge)
    .map((line) => `${prefix}${continuationGlyph}${line}\n`)
    .join("");
  return head + preview;
}

function callerPreview(edge: CallEdge): readonly string[] {
  const [firstSite] = edge.sites;
  return firstSite === undefined ? [] : [firstSite.previewSource];
}

function calleePreview(edge: CallEdge): readonly string[] {
  return edge.symbol.signature.lines;
}

function renderReferences(references: ContextReferenceSummary, id: string): string {
  if (references.total === 0) {
    return `References\n${NONE}`;
  }
  const lines = [`References`, `Total: ${references.total}`];
  const kinds = renderKinds(references);
  if (kinds !== undefined) {
    lines.push(kinds);
  }
  lines.push(`Run: symnav refs ${id}`);
  return lines.map((line) => `${line}\n`).join("");
}

function renderKinds(references: ContextReferenceSummary): string | undefined {
  const parts = KIND_ORDER.filter((kind) => references.kindCounts[kind] > 0).map(
    (kind) => `${kind} ${references.kindCounts[kind]}`,
  );
  if (parts.length === 0) {
    return undefined;
  }
  return `Kinds: ${parts.join(", ")}`;
}

function renderHistory(history: readonly HistoryEntry[]): string {
  if (history.length === 0) {
    return `Recent History\n${NONE}`;
  }
  const entries = history
    .map(
      (entry, index) =>
        `${index + 1}. ${entry.shortSha} ${entry.isoDate} ${entry.author}\n   ${entry.subject}\n`,
    )
    .join("\n");
  return `Recent History\n${entries}`;
}
