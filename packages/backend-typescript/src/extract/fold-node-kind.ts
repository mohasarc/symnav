import { Node } from "ts-morph";

export type TypeScriptFoldKind =
  | "call"
  | "block"
  | "loop"
  | "conditional"
  | "switch"
  | "switchCase"
  | "switchDefault"
  | "try"
  | "catch"
  | "finally";

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
  if (Node.isSwitchStatement(node)) return "switch";
  if (Node.isCaseClause(node)) return "switchCase";
  if (Node.isDefaultClause(node)) return "switchDefault";
  if (Node.isTryStatement(node)) return "try";
  return undefined;
}
