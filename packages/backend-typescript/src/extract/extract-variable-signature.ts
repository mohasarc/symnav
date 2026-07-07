import {
  Node,
  type CallExpression,
  type VariableDeclaration,
  type VariableStatement,
} from "ts-morph";

export interface ExtractVariableSignatureArgs {
  readonly statement: VariableStatement;
  readonly declaration: VariableDeclaration;
}

export function extractVariableSignature({
  statement,
  declaration,
}: ExtractVariableSignatureArgs): string {
  const head = variableHead(statement, declaration);
  const initializer = declaration.getInitializer();
  if (!initializer) return head;
  return `${head} = ${collapsedInitializer(initializer)}`;
}

function variableHead(statement: VariableStatement, declaration: VariableDeclaration): string {
  const keyword = statement.getDeclarationList().getDeclarationKind();
  const modifiers = statement
    .getModifiers()
    .map((modifier) => modifier.getText())
    .join(" ");
  const declarationHead = `${modifiers ? `${modifiers} ` : ""}${keyword} ${declaration.getName()}`;
  const typeNode = declaration.getTypeNode();
  return typeNode ? `${declarationHead}: ${typeNode.getText()}` : declarationHead;
}

function collapsedInitializer(node: Node): string {
  if (Node.isObjectLiteralExpression(node)) return "{ … }";
  if (Node.isArrayLiteralExpression(node)) return "[…]";
  if (Node.isCallExpression(node)) return collapsedCallExpression(node);
  if (Node.isFunctionExpression(node) || Node.isArrowFunction(node)) {
    return `${functionValuedInitializerHead(node)} …`;
  }
  return node.getText();
}

function collapsedCallExpression(node: CallExpression): string {
  const expression = node.getExpression();
  if (Node.isPropertyAccessExpression(expression)) {
    const receiver = expression.getExpression();
    const receiverText = Node.isCallExpression(receiver)
      ? collapsedCallExpression(receiver)
      : receiver.getText();
    return `${receiverText}.${expression.getName()}(…)`;
  }
  return `${expression.getText()}(…)`;
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
