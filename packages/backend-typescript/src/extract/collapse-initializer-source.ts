import { Node, SyntaxKind, type CallExpression, type NewExpression } from "ts-morph";

const VERBATIM_INITIALIZER_MAX_LENGTH = 40;

export function collapseInitializerSource(node: Node): string {
  const expression = expressionForCollapse(node);
  if (fitsVerbatim(expression)) return expression.getText();
  if (Node.isAwaitExpression(expression)) {
    return `await ${collapseInitializerSource(expression.getExpression())}`;
  }
  if (Node.isVoidExpression(expression)) {
    return `void ${collapseInitializerSource(expression.getExpression())}`;
  }
  if (Node.isTypeOfExpression(expression)) {
    return `typeof ${collapseInitializerSource(expression.getExpression())}`;
  }
  if (Node.isDeleteExpression(expression)) {
    return `delete ${collapseInitializerSource(expression.getExpression())}`;
  }
  if (Node.isPrefixUnaryExpression(expression)) {
    return [
      prefixUnaryOperatorText(expression.getOperatorToken()),
      collapseInitializerSource(expression.getOperand()),
    ].join("");
  }
  if (Node.isObjectLiteralExpression(expression)) return "{ … }";
  if (Node.isArrayLiteralExpression(expression)) return "[…]";
  if (Node.isCallExpression(expression)) return collapseCallExpression(expression);
  if (Node.isNewExpression(expression)) return collapseNewExpression(expression);
  if (Node.isConditionalExpression(expression)) {
    return [
      collapseInitializerSource(expression.getCondition()),
      "?",
      collapseInitializerSource(expression.getWhenTrue()),
      ":",
      collapseInitializerSource(expression.getWhenFalse()),
    ].join(" ");
  }
  if (Node.isPropertyAccessExpression(expression)) {
    return `${collapseInitializerSource(expression.getExpression())}.${expression.getName()}`;
  }
  if (Node.isTaggedTemplateExpression(expression)) {
    return `${collapseInitializerSource(expression.getTag())}\`…\``;
  }
  if (Node.isFunctionExpression(expression) || Node.isArrowFunction(expression)) {
    return `${functionValuedInitializerHead(expression)} …`;
  }
  return "…";
}

function fitsVerbatim(node: Node): boolean {
  const text = node.getText();
  return !text.includes("\n") && text.length <= VERBATIM_INITIALIZER_MAX_LENGTH;
}

function expressionForCollapse(node: Node): Node {
  if (
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isTypeAssertion(node) ||
    Node.isNonNullExpression(node) ||
    Node.isParenthesizedExpression(node)
  ) {
    return expressionForCollapse(node.getExpression());
  }
  return node;
}

function collapseCallExpression(node: CallExpression): string {
  const argumentList = node.getArguments().length > 0 ? "(…)" : "()";
  const expression = expressionForCollapse(node.getExpression());
  if (Node.isPropertyAccessExpression(expression)) {
    return `${collapseInitializerSource(expression.getExpression())}.${expression.getName()}${argumentList}`;
  }
  if (Node.isCallExpression(expression))
    return `${collapseCallExpression(expression)}${argumentList}`;
  return `${collapseInitializerSource(expression)}${argumentList}`;
}

function collapseNewExpression(node: NewExpression): string {
  const constructorHead = newExpressionConstructorHead(node);
  if (node.getArguments().length > 0) return `new ${constructorHead}(…)`;
  return node.getText().trimEnd().endsWith(")")
    ? `new ${constructorHead}()`
    : `new ${constructorHead}`;
}

function newExpressionConstructorHead(node: NewExpression): string {
  const expression = expressionForCollapse(node.getExpression());
  const typeArguments = node.getTypeArguments();
  const typeArgumentText =
    typeArguments.length > 0
      ? `<${typeArguments.map((typeArgument) => typeArgument.getText()).join(", ")}>`
      : "";
  if (Node.isClassExpression(expression)) return `class …${typeArgumentText}`;
  return `${collapseInitializerSource(expression)}${typeArgumentText}`;
}

function prefixUnaryOperatorText(operator: SyntaxKind): string {
  if (operator === SyntaxKind.PlusPlusToken) return "++";
  if (operator === SyntaxKind.MinusMinusToken) return "--";
  if (operator === SyntaxKind.PlusToken) return "+";
  if (operator === SyntaxKind.MinusToken) return "-";
  if (operator === SyntaxKind.TildeToken) return "~";
  if (operator === SyntaxKind.ExclamationToken) return "!";
  return "";
}

function functionValuedInitializerHead(node: Node): string {
  if (Node.isFunctionExpression(node)) {
    const body = node.getBody();
    if (!body) return node.getText();
    return node
      .getText()
      .slice(0, body.getStart() - node.getStart())
      .trimEnd();
  }
  if (Node.isArrowFunction(node)) {
    const body = node.getBody();
    return node
      .getText()
      .slice(0, body.getStart() - node.getStart())
      .trimEnd();
  }
  return node.getText();
}
