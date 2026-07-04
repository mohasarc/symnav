import type {
  CallEdge,
  CappedCertainCallEdges,
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

type PreviewLinesFor = (edge: CallEdge) => readonly string[];

export function renderContextText(result: ContextResult): string {
  return ContextTextRenderer.render(result);
}

class ContextTextRenderer {
  private static readonly KIND_ORDER: readonly ReferenceKind[] = [
    "usage",
    "import",
    "export",
    "type",
  ];
  private static readonly NONE = "(none)\n";

  static render(result: ContextResult): string {
    const head =
      `Context: ${formatIdentityPath(result.identity)}\n` +
      `File: ${result.identity.file}\n` +
      `Lines: ${formatRange(result.target.range)}\n`;
    const id = formatSymbolIdentity(result.identity);
    const sections = [
      ContextTextRenderer.renderDefinition(result.definitions),
      ContextTextRenderer.renderEdges(
        "Callers",
        result.callers,
        ContextTextRenderer.callerPreview,
        ContextTextRenderer.overflowLine("callers", "--incoming", id),
      ),
      ContextTextRenderer.renderEdges(
        "Callees",
        result.callees,
        ContextTextRenderer.calleePreview,
        ContextTextRenderer.overflowLine("callees", "--outgoing", id),
      ),
      ContextTextRenderer.renderReferences(result.references, id),
      ContextTextRenderer.renderHistory(result.history),
    ];
    return [head, ...sections].join("\n");
  }

  private static renderDefinition(definitions: readonly SymbolDecl[]): string {
    if (definitions.length === 0) {
      return `Definition\n${ContextTextRenderer.NONE}`;
    }
    const groups = [...groupByFile(definitions).entries()]
      .map(([file, symbols]) => ContextTextRenderer.renderDefinitionFileGroup(file, symbols))
      .join("");
    return `Definition\n${groups}`;
  }

  private static renderDefinitionFileGroup(file: string, symbols: readonly SymbolDecl[]): string {
    const entries = symbols
      .map((symbol, index) =>
        ContextTextRenderer.renderDefinitionEntry(symbol, index === symbols.length - 1),
      )
      .join("");
    return `${file}\n${entries}`;
  }

  private static renderDefinitionEntry(symbol: SymbolDecl, isLast: boolean): string {
    const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
    const tag = bracketTagFor(symbol.kind.nativeLabel);
    const tagSuffix = tag === undefined ? "" : `  [${tag}]`;
    const head = `${branchGlyph}${formatRange(symbol.range)}: ${formatIdentityPath(symbol.identity)}${tagSuffix}\n`;
    const signature = symbol.signature.lines
      .map((line) => `${continuationGlyph}${line}\n`)
      .join("");
    return head + signature;
  }

  private static renderEdges(
    header: string,
    capped: CappedCertainCallEdges,
    previewLinesFor: PreviewLinesFor,
    overflow: string,
  ): string {
    if (capped.sortedEdges.length === 0 && capped.omittedCertainEdgeCount === 0) {
      return `${header}\n${ContextTextRenderer.NONE}`;
    }
    const tree = buildCallEdgeTree(capped.sortedEdges)
      .map((node) => ContextTextRenderer.renderRootNode(node, previewLinesFor))
      .join("");
    const overflowSuffix =
      capped.omittedCertainEdgeCount === 0
        ? ""
        : overflow.replace("{N}", `${capped.omittedCertainEdgeCount}`);
    return `${header}\n${tree}${overflowSuffix}`;
  }

  private static overflowLine(noun: string, direction: string, id: string): string {
    return `… {N} more ${noun}. Run: symnav graph ${id} ${direction}\n`;
  }

  private static renderRootNode(node: CallEdgeTreeNode, previewLinesFor: PreviewLinesFor): string {
    return `${node.subpath}\n` + ContextTextRenderer.renderChildren(node, "", previewLinesFor);
  }

  private static renderChildren(
    node: CallEdgeTreeNode,
    prefix: string,
    previewLinesFor: PreviewLinesFor,
  ): string {
    if ("edges" in node) {
      return node.edges
        .map((edge, index) =>
          ContextTextRenderer.renderEdgeEntry(
            edge,
            prefix,
            index === node.edges.length - 1,
            previewLinesFor,
          ),
        )
        .join("");
    }
    return node.children
      .map((child, index) => {
        const isLast = index === node.children.length - 1;
        const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
        const subpathLine = `${prefix}${branchGlyph}${child.subpath}\n`;
        return (
          subpathLine +
          ContextTextRenderer.renderChildren(child, prefix + continuationGlyph, previewLinesFor)
        );
      })
      .join("");
  }

  private static renderEdgeEntry(
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

  private static callerPreview(edge: CallEdge): readonly string[] {
    const [firstSite] = edge.sites;
    return firstSite === undefined ? [] : [firstSite.previewSource];
  }

  private static calleePreview(edge: CallEdge): readonly string[] {
    return edge.symbol.signature.lines;
  }

  private static renderReferences(references: ContextReferenceSummary, id: string): string {
    if (references.total === 0) {
      return `References\n${ContextTextRenderer.NONE}`;
    }
    const lines = [`References`, `Total: ${references.total}`];
    const kinds = ContextTextRenderer.renderKinds(references);
    if (kinds !== undefined) {
      lines.push(kinds);
    }
    lines.push(`Run: symnav refs ${id}`);
    return lines.map((line) => `${line}\n`).join("");
  }

  private static renderKinds(references: ContextReferenceSummary): string | undefined {
    const parts = ContextTextRenderer.KIND_ORDER.filter(
      (kind) => references.kindCounts[kind] > 0,
    ).map((kind) => `${kind} ${references.kindCounts[kind]}`);
    if (parts.length === 0) {
      return undefined;
    }
    return `Kinds: ${parts.join(", ")}`;
  }

  private static renderHistory(history: readonly HistoryEntry[]): string {
    if (history.length === 0) {
      return `Recent History\n${ContextTextRenderer.NONE}`;
    }
    const entries = history
      .map(
        (entry, index) =>
          `${index + 1}. ${entry.shortSha} ${entry.isoDate} ${entry.author}\n   ${entry.subject}\n`,
      )
      .join("\n");
    return `Recent History\n${entries}`;
  }
}
