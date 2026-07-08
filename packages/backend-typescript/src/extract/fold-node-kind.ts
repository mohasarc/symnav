import { Node } from "ts-morph";

export type TypeScriptFoldKind =
  | "call"
  | "block"
  | "loop"
  | "conditional"
  | "switch"
  | "try"
  | "catch"
  | "finally"
  | "callback";

export function foldKindOf(node: Node): TypeScriptFoldKind | undefined {
  if (Node.isExpressionStatement(node) && Node.isCallExpression(node.getExpression())) {
    return "call";
  }
  if (Node.isBlock(node)) return "block";
  if (Node.isIfStatement(node)) return "conditional";
  if (
    Node.isForStatement(node) ||
    Node.isForInStatement(node) ||
    Node.isForOfStatement(node) ||
    Node.isWhileStatement(node) ||
    Node.isDoStatement(node)
  ) {
    return "loop";
  }
  if (Node.isSwitchStatement(node) || Node.isCaseClause(node) || Node.isDefaultClause(node)) {
    return "switch";
  }
  if (Node.isTryStatement(node)) return "try";
  if (Node.isCatchClause(node)) return "catch";
  return foldKindOfFinally(node);
}

function foldKindOfFinally(node: Node): TypeScriptFoldKind | undefined {
  if (node.getKindName() === "Block" && Node.isTryStatement(node.getParent())) {
    const parent = node.getParentOrThrow();
    if (Node.isTryStatement(parent) && parent.getFinallyBlock() === node) {
      return "finally";
    }
  }
  return undefined;
}
