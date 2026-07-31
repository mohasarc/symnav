import { Node, SyntaxKind, type CallExpression, type ExpressionStatement } from "ts-morph";

export function statementCallExpression(
  statement: ExpressionStatement,
): CallExpression | undefined {
  return unwrapToCallExpression(statement.getExpression());
}

function unwrapToCallExpression(expression: Node): CallExpression | undefined {
  if (Node.isCallExpression(expression)) return expression;
  if (Node.isAwaitExpression(expression)) {
    return unwrapToCallExpression(expression.getExpression());
  }
  if (
    Node.isBinaryExpression(expression) &&
    expression.getOperatorToken().getKind() === SyntaxKind.EqualsToken
  ) {
    return unwrapToCallExpression(expression.getRight());
  }
  return undefined;
}
