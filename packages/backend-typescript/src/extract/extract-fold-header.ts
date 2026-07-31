import { Node, type ExpressionStatement } from "ts-morph";
import { splitHeaderLines, type Header } from "@symnav/core";

import { statementCallExpression, trailingCallbackBody } from "./trailing-callback.js";

export function extractFoldHeader(node: Node): Header {
  return {
    startLine: node.getStartLineNumber(),
    lines: splitHeaderLines(foldHeaderText(node)),
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
  if (call && trailingCallbackBody(call)) {
    return textThroughFirst(node.getText(), "{");
  }
  return firstLine(node.getText());
}

function textThroughFirst(text: string, token: string): string {
  const index = text.indexOf(token);
  if (index === -1) return firstLine(text);
  return text.slice(0, index + token.length).trimEnd();
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trimEnd() ?? "";
}
