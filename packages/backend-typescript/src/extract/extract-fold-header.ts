import { Node, type ExpressionStatement } from "ts-morph";
import { splitHeaderLines, type Header } from "@symnav/core";

import { statementCallExpression, trailingCallbackBody } from "./trailing-callback.js";

export class FoldHeaderExtractor {
  static extract(node: Node): Header {
    return {
      startLine: node.getStartLineNumber(),
      lines: splitHeaderLines(FoldHeaderExtractor.foldHeaderText(node)),
    };
  }

  private static foldHeaderText(node: Node): string {
    if (Node.isBlock(node)) return "{";
    if (Node.isCaseClause(node) || Node.isDefaultClause(node)) {
      return FoldHeaderExtractor.textThroughFirst(node.getText(), ":");
    }
    if (Node.isExpressionStatement(node)) {
      return FoldHeaderExtractor.expressionStatementHeader(node);
    }
    return FoldHeaderExtractor.textThroughFirst(node.getText(), "{");
  }

  private static expressionStatementHeader(node: ExpressionStatement): string {
    const call = statementCallExpression(node);
    if (call && trailingCallbackBody(call)) {
      return FoldHeaderExtractor.textThroughFirst(node.getText(), "{");
    }
    return FoldHeaderExtractor.firstLine(node.getText());
  }

  private static textThroughFirst(text: string, token: string): string {
    const index = text.indexOf(token);
    if (index === -1) return FoldHeaderExtractor.firstLine(text);
    return text.slice(0, index + token.length).trimEnd();
  }

  private static firstLine(text: string): string {
    return text.split(/\r?\n/, 1)[0]?.trimEnd() ?? "";
  }
}
