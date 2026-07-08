import { Node } from "ts-morph";
import type { LineRange, ReExportOverviewNode, Signature } from "@symnav/core";

export function extractReExportEntry(
  node: Node,
  filePath: string,
): ReExportOverviewNode | undefined {
  void filePath;
  if (!Node.isExportDeclaration(node)) return undefined;
  const sourceModule = node.getModuleSpecifierValue();
  if (!sourceModule) return undefined;

  const namespaceExport = node.getNamespaceExport();
  const namedExports = node.getNamedExports();
  if (namespaceExport) {
    return reExportNode(node, "namespace", [namespaceExport.getName()], sourceModule);
  }
  if (namedExports.length > 0) {
    return reExportNode(
      node,
      "named",
      namedExports.map((namedExport) => namedExport.getAliasNode()?.getText() ?? namedExport.getName()),
      sourceModule,
    );
  }
  return reExportNode(node, "star", [], sourceModule);
}

function reExportNode(
  node: Node,
  exportKind: ReExportOverviewNode["exportKind"],
  exportedNames: readonly string[],
  sourceModule: string,
): ReExportOverviewNode {
  const range = nodeRange(node);
  return {
    type: "re-export",
    exportKind,
    exportedNames,
    sourceModule,
    range,
    header: signatureFrom(range.startLine, node.getText()),
    children: [],
  };
}

function signatureFrom(startLine: number, text: string): Signature {
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
