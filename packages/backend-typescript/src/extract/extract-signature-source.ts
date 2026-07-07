import { Node, SyntaxKind, type ExportAssignment } from "ts-morph";

import { collapseInitializerSource } from "./collapse-initializer-source.js";

export function extractSignatureSource(node: Node): string {
  return dedentContinuationLines(rawSignatureSource(node), ambientIndentation(node));
}

function rawSignatureSource(node: Node): string {
  if (Node.isExportAssignment(node)) return exportAssignmentSignature(node);
  if (Node.isPropertyDeclaration(node)) return propertySignature(node);
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

function exportAssignmentSignature(node: ExportAssignment): string {
  const keyword = node.isExportEquals() ? "export =" : "export default";
  return `${keyword} ${collapseInitializerSource(node.getExpression())}`;
}

function propertySignature(node: Node): string {
  if (!Node.isPropertyDeclaration(node)) return cutBeforeTerminator(node);
  const initializer = node.getInitializer();
  if (!initializer) return cutBeforeTerminator(node);
  return `${headBeforeInitializer(node, initializer)} = ${collapseInitializerSource(initializer)}`;
}

function headBeforeInitializer(node: Node, initializer: Node): string {
  return node
    .getText()
    .slice(0, initializer.getStart() - node.getStart())
    .trimEnd()
    .replace(/\s*=$/, "")
    .trimEnd();
}

function ambientIndentation(node: Node): number {
  return node.getStart() - node.getStartLinePos();
}

function dedentContinuationLines(source: string, ambient: number): string {
  const lines = source.split("\n");
  if (lines.length <= 1 || ambient === 0) {
    return source;
  }
  const dedented = lines.map((line, index) => (index === 0 ? line : stripLeading(line, ambient)));
  return dedented.join("\n");
}

function stripLeading(line: string, max: number): string {
  let removable = 0;
  while (removable < max && line[removable] === " ") {
    removable += 1;
  }
  return line.slice(removable);
}

function cutBeforeOpeningBrace(node: Node): string {
  const openingBrace = node.getFirstChildByKind(SyntaxKind.OpenBraceToken);
  if (openingBrace) {
    const text = node.getText();
    return text.slice(0, openingBrace.getStart() - node.getStart()).trimEnd();
  }
  const text = node.getText();
  const brace = text.indexOf("{");
  return brace === -1 ? text.trimEnd() : text.slice(0, brace).trimEnd();
}

function cutBeforeTerminator(node: Node): string {
  const text = node.getText();
  return text.endsWith(";") ? text.slice(0, -1).trimEnd() : text.trimEnd();
}

function cutBeforeBodyOrTerminator(node: Node): string {
  const body = bodyOf(node);
  if (body) {
    const text = node.getText();
    const bodyStart = body.getStart() - node.getStart();
    return text.slice(0, bodyStart).trimEnd();
  }
  return cutBeforeTerminator(node);
}

function bodyOf(node: Node): Node | undefined {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isConstructorDeclaration(node)
  ) {
    return node.getBody();
  }
  return undefined;
}
