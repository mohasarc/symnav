import { SyntaxKind, ts, type Node } from "ts-morph";
import type { ReferenceKind } from "@symnav/core";

export function classifyReferenceKind(node: Node): ReferenceKind {
  if (node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) return "import";
  if (isInExportClause(node)) return "export";
  if (isInTypePosition(node)) return "type";
  return "usage";
}

function isInExportClause(node: Node): boolean {
  return (
    node.getFirstAncestorByKind(SyntaxKind.ExportDeclaration) !== undefined ||
    node.getFirstAncestorByKind(SyntaxKind.ExportAssignment) !== undefined
  );
}

function isInTypePosition(node: Node): boolean {
  if (ts.isPartOfTypeNode(node.compilerNode)) return true;
  const enclosingTypeNode = node.getFirstAncestor((ancestor) =>
    ts.isPartOfTypeNode(ancestor.compilerNode),
  );
  return enclosingTypeNode !== undefined;
}
