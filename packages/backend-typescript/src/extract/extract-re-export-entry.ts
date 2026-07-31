import { Node } from "ts-morph";
import type { LineRange, ReExportOverviewNode, Header } from "@symnav/core";

export function extractReExportEntry(node: Node): ReExportOverviewNode | undefined {
  if (!Node.isExportDeclaration(node)) return undefined;
  const sourceModule = node.getModuleSpecifierValue();

  const namespaceExport = node.getNamespaceExport();
  if (namespaceExport) {
    return reExportNode(node, "namespace", [namespaceExport.getName()], sourceModule);
  }
  if (sourceModule && !node.hasNamedExports()) {
    return reExportNode(node, "star", [], sourceModule);
  }
  return reExportNode(
    node,
    "named",
    node
      .getNamedExports()
      .map((namedExport) => namedExport.getAliasNode()?.getText() ?? namedExport.getName()),
    sourceModule,
  );
}

function reExportNode(
  node: Node,
  exportKind: ReExportOverviewNode["exportKind"],
  exportedNames: readonly string[],
  sourceModule: string | undefined,
): ReExportOverviewNode {
  const range = nodeRange(node);
  return {
    type: "re-export",
    exportKind,
    exportedNames,
    sourceModule,
    range,
    header: headerFrom(range.startLine, node.getText()),
  };
}

function headerFrom(startLine: number, text: string): Header {
  return {
    startLine,
    lines: [text],
  };
}

function nodeRange(node: Node): LineRange {
  return {
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
  };
}
