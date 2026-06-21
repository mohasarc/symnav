import type { SymbolReference, ReferenceKind, RefsResult } from "@symnav/core";

import { formatIdentityPath, treeGlyphsFor } from "../shared/render-format.js";
import type { ReferenceTreeNode } from "./reference-tree.js";
import { buildReferenceTree } from "./reference-tree.js";
import { fullPreview, trimPreview } from "./trim-preview.js";

const KIND_ORDER: readonly ReferenceKind[] = ["usage", "import", "export", "type"];

type PreviewFor = (reference: SymbolReference) => string;

export function renderRefsText(result: RefsResult): string {
  const header = renderHeader(result);
  if (result.references.length === 0) {
    return header;
  }
  const previewFor = result.fullLines ? fullPreview : trimPreview;
  const tree = buildReferenceTree(result.references)
    .map((node) => renderRootNode(node, previewFor))
    .join("");
  return `${header}\n${tree}`;
}

function renderHeader(result: RefsResult): string {
  const lines = [`References: ${formatIdentityPath(result.identity)}`, `Total: ${result.total}`];
  const kinds = renderKinds(result);
  if (kinds !== undefined) {
    lines.push(kinds);
  }
  lines.push(`Page: ${result.page}/${result.pageCount}`, "Sort: path, line");
  return lines.map((line) => `${line}\n`).join("");
}

function renderKinds(result: RefsResult): string | undefined {
  const parts = KIND_ORDER.filter((kind) => result.kindCounts[kind] > 0).map(
    (kind) => `${kind} ${result.kindCounts[kind]}`,
  );
  if (parts.length === 0) {
    return undefined;
  }
  return `Kinds: ${parts.join(", ")}`;
}

function renderRootNode(node: ReferenceTreeNode, previewFor: PreviewFor): string {
  return `${node.subpath}\n` + renderChildren(node, "", previewFor);
}

function renderChildren(node: ReferenceTreeNode, prefix: string, previewFor: PreviewFor): string {
  if ("references" in node) {
    return node.references
      .map((reference, index) =>
        renderReferenceEntry(reference, prefix, index === node.references.length - 1, previewFor),
      )
      .join("");
  }
  return node.children
    .map((child, index) => {
      const isLast = index === node.children.length - 1;
      const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
      const subpathLine = `${prefix}${branchGlyph}${child.subpath}\n`;
      return subpathLine + renderChildren(child, prefix + continuationGlyph, previewFor);
    })
    .join("");
}

function renderReferenceEntry(
  reference: SymbolReference,
  prefix: string,
  isLast: boolean,
  previewFor: PreviewFor,
): string {
  const { branchGlyph } = treeGlyphsFor(isLast);
  return `${prefix}${branchGlyph}${reference.line}: ${previewFor(reference)}  [${reference.kind}]\n`;
}
