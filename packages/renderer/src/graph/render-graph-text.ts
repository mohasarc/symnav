import type { GraphDirectionPage, GraphPathStep, GraphResult, SymbolDecl } from "@symnav/core";

import { formatIdentityPath, formatRange, treeGlyphsFor } from "../shared/render-format.js";
import type { GraphPathTreeNode } from "./graph-path-tree.js";
import { buildGraphPathTree } from "./graph-path-tree.js";

type GraphDirectionLabel = "caller" | "callee";

export function renderGraphText(result: GraphResult): string {
  return GraphTextRenderer.render(result);
}

class GraphTextRenderer {
  static render(result: GraphResult): string {
    const header = [
      `Graph: ${formatIdentityPath(result.identity)}`,
      `File: ${result.identity.file}`,
      `Lines: ${formatRange(result.root.range)}`,
      `Depth: ${result.depth}`,
      `Direction: ${result.direction}`,
      "Edges: calls",
      ...(result.pageCount > 1 ? [`Page: ${result.page}/${result.pageCount}`] : []),
    ].join("\n");
    const sections = [
      ...(result.incoming === undefined
        ? []
        : [GraphTextRenderer.renderDirection("Incoming", "caller", result.root, result.incoming)]),
      ...(result.outgoing === undefined
        ? []
        : [GraphTextRenderer.renderDirection("Outgoing", "callee", result.root, result.outgoing)]),
    ];
    const note = GraphTextRenderer.renderRepeatedSymbolNote(result.repeatedSymbolCount);
    return `${[header, ...sections, ...(note === undefined ? [] : [note])].join("\n\n")}\n`;
  }

  private static renderDirection(
    header: string,
    label: GraphDirectionLabel,
    root: SymbolDecl,
    page: GraphDirectionPage,
  ): string {
    const tree = buildGraphPathTree(page.paths);
    return `${header}\n${root.identity.file}\n${GraphTextRenderer.renderRoot(root, tree, label).trimEnd()}`;
  }

  private static renderRoot(
    root: SymbolDecl,
    children: readonly GraphPathTreeNode[],
    label: GraphDirectionLabel,
  ): string {
    const head = `└── ${formatRange(root.range)}: ${formatIdentityPath(root.identity)}\n`;
    const signatures = root.signature.lines.map((line) => `    ${line}\n`).join("");
    return head + signatures + GraphTextRenderer.renderChildren(children, "    ", label);
  }

  private static renderChildren(
    children: readonly GraphPathTreeNode[],
    prefix: string,
    label: GraphDirectionLabel,
  ): string {
    return GraphTextRenderer.groupChildrenByFile(children)
      .map((group, index, groups) =>
        GraphTextRenderer.renderFileGroup(group, prefix, index === groups.length - 1, label),
      )
      .join("");
  }

  private static renderFileGroup(
    group: GraphPathTreeFileGroup,
    prefix: string,
    isLast: boolean,
    label: GraphDirectionLabel,
  ): string {
    const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
    const fileLine = `${prefix}${branchGlyph}${group.file}\n`;
    const entries = group.nodes
      .map((node, index) =>
        GraphTextRenderer.renderNode(
          node,
          `${prefix}${continuationGlyph}`,
          index === group.nodes.length - 1,
          label,
        ),
      )
      .join("");
    return fileLine + entries;
  }

  private static renderNode(
    node: GraphPathTreeNode,
    prefix: string,
    isLast: boolean,
    label: GraphDirectionLabel,
  ): string {
    const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
    const tag = GraphTextRenderer.renderStepTag(node.step, label);
    const head = `${prefix}${branchGlyph}${formatRange(node.step.symbol.range)}: ${formatIdentityPath(node.step.symbol.identity)}${tag}\n`;
    const signaturePrefix = `${prefix}${continuationGlyph}`;
    const signatures = node.step.symbol.signature.lines
      .map((line) => `${signaturePrefix}${line}\n`)
      .join("");
    if (node.step.closesCycle) {
      return head + signatures;
    }
    return (
      head + signatures + GraphTextRenderer.renderChildren(node.children, signaturePrefix, label)
    );
  }

  private static renderStepTag(step: GraphPathStep, label: GraphDirectionLabel): string {
    const confidenceTag =
      step.confidence === "possible"
        ? `possible${step.reason === undefined ? "" : `: ${step.reason}`}`
        : label;
    const cycleTag = step.closesCycle ? "  [cycle]" : "";
    return `  [${confidenceTag}]${cycleTag}`;
  }

  private static groupChildrenByFile(
    children: readonly GraphPathTreeNode[],
  ): readonly GraphPathTreeFileGroup[] {
    const groups: GraphPathTreeFileGroup[] = [];
    for (const child of children) {
      const file = child.step.symbol.identity.file;
      const previousGroup = groups.at(-1);
      if (previousGroup?.file !== file) {
        groups.push({ file, nodes: [child] });
        continue;
      }
      previousGroup.nodes.push(child);
    }
    return groups;
  }

  private static renderRepeatedSymbolNote(count: number): string | undefined {
    if (count === 0) {
      return undefined;
    }
    const noun = count === 1 ? "symbol appears" : "symbols appear";
    return `Note: ${count} ${noun} in multiple paths.`;
  }
}

interface GraphPathTreeFileGroup {
  readonly file: string;
  readonly nodes: GraphPathTreeNode[];
}
