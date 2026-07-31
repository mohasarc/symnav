import { Node, type CallExpression, type ExpressionStatement } from "ts-morph";
import type { Header } from "@symnav/core";

import { statementCallExpression } from "./trailing-callback.js";

export function extractFoldHeader(node: Node): Header {
  return {
    startLine: node.getStartLineNumber(),
    lines: [foldHeaderText(node)],
  };
}

function foldHeaderText(node: Node): string {
  if (Node.isBlock(node)) return "{";
  if (Node.isCaseClause(node) || Node.isDefaultClause(node)) {
    return textThroughFirst(node.getText(), ":");
  }
  if (Node.isExpressionStatement(node)) {
    return expressionStatementHeader(node);
  }
  return textThroughFirst(node.getText(), "{");
}

function expressionStatementHeader(node: ExpressionStatement): string {
  const call = statementCallExpression(node);
  if (call && trailingFunctionBody(call)) {
    return textThroughFirst(node.getText(), "{");
  }
  return firstLine(node.getText());
}

function trailingFunctionBody(node: CallExpression): Node | undefined {
  const args = node.getArguments();
  const trailing = args[args.length - 1];
  if (!trailing) return undefined;
  if (Node.isArrowFunction(trailing)) {
    const body = trailing.getBody();
    return Node.isBlock(body) ? body : undefined;
  }
  if (Node.isFunctionExpression(trailing)) {
    return trailing.getBody();
  }
  return undefined;
}

function textThroughFirst(text: string, token: string): string {
  const index = text.indexOf(token);
  if (index === -1) return firstLine(text);
  return text.slice(0, index + token.length).trimEnd();
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trimEnd() ?? "";
}
