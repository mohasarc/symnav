import { Node, SyntaxKind, type VariableDeclaration } from "ts-morph";

export function extractSignatureSource(node: Node): string {
  if (Node.isVariableStatement(node)) return variableStatementSignature(node);
  if (Node.isExportAssignment(node)) return node.getExpression().getText();
  if (Node.isTypeAliasDeclaration(node)) return cutBeforeTerminator(node);
  if (
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isModuleDeclaration(node)
  ) {
    return cutBeforeOpeningBrace(node);
  }
  return cutBeforeBodyOrTerminator(node);
}

function cutBeforeOpeningBrace(node: Node): string {
  const text = node.getText();
  const brace = text.indexOf("{");
  return brace === -1 ? text.trimEnd() : text.slice(0, brace).trimEnd();
}

function cutBeforeTerminator(node: Node): string {
  const text = node.getText();
  return text.endsWith(";") ? text.slice(0, -1).trimEnd() : text.trimEnd();
}

function cutBeforeBodyOrTerminator(node: Node): string {
  const body = (node as { getBody?: () => Node | undefined }).getBody?.();
  if (body) {
    const text = node.getText();
    const bodyStart = body.getStart() - node.getStart();
    return text.slice(0, bodyStart).trimEnd();
  }
  return cutBeforeTerminator(node);
}

function variableStatementSignature(node: Node): string {
  if (!Node.isVariableStatement(node)) return node.getText();
  const declList = node.getDeclarationList();
  const keyword = declList.getFirstChildByKind(SyntaxKind.ConstKeyword)
    ? "const"
    : declList.getFirstChildByKind(SyntaxKind.LetKeyword)
      ? "let"
      : "var";
  const decl = declList.getDeclarations()[0];
  if (!decl) return node.getText();
  return `${keyword} ${variableDeclarationSignature(decl)}`;
}

function variableDeclarationSignature(decl: VariableDeclaration): string {
  const name = decl.getName();
  const typeNode = decl.getTypeNode();
  if (typeNode) return `${name}: ${typeNode.getText()}`;
  const initializer = decl.getInitializer();
  if (initializer) return `${name} = ${initializer.getText()}`;
  return name;
}
