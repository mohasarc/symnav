import {
  Node,
  SyntaxKind,
  type Block,
  type CallExpression,
  type ExpressionStatement,
} from "ts-morph";

export function statementCallExpression(
  statement: ExpressionStatement,
): CallExpression | undefined {
  return unwrapToCallExpression(statement.getExpression());
}

export function trailingCallbackBody(call: CallExpression): Block | undefined {
  const args = call.getArguments();
  const trailing = args[args.length - 1];
  if (!trailing) return undefined;
  if (Node.isArrowFunction(trailing) || Node.isFunctionExpression(trailing)) {
    const body = trailing.getBody();
    return Node.isBlock(body) ? body : undefined;
  }
  return undefined;
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
