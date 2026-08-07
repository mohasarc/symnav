import { Node, type ExpressionStatement } from "ts-morph";

import { statementCallExpression, trailingCallbackBody } from "./trailing-callback.js";

export class FoldHeaderVariantsExtractor {
  static extract(node: Node): readonly string[] {
    if (!Node.isExpressionStatement(node)) return [];
    const call = statementCallExpression(node);
    if (!call || !trailingCallbackBody(call)) return [];
    const trailingArgument = call.getArguments().at(-1);
    if (!trailingArgument) return [];
    return [FoldHeaderVariantsExtractor.closedCallForm(node, trailingArgument)];
  }

  private static closedCallForm(statement: ExpressionStatement, trailingArgument: Node): string {
    const upToTrailingArgument = statement
      .getText()
      .slice(0, trailingArgument.getStart() - statement.getStart());
    return FoldHeaderVariantsExtractor.withoutTrailingComma(upToTrailingArgument) + ")";
  }

  private static withoutTrailingComma(text: string): string {
    const trimmed = text.trimEnd();
    if (trimmed.endsWith(",")) return trimmed.slice(0, -1).trimEnd();
    return trimmed;
  }
}
