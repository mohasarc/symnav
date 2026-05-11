import { Node } from "ts-morph";
import type { SymbolKind } from "@symnav/core";

export function nodeKind(node: Node): SymbolKind | null {
  if (Node.isFunctionDeclaration(node)) return "function";
  if (Node.isClassDeclaration(node)) return "class";
  if (Node.isInterfaceDeclaration(node)) return "interface";
  if (Node.isTypeAliasDeclaration(node)) return "type-alias";
  if (Node.isEnumDeclaration(node)) return "enum";
  if (Node.isModuleDeclaration(node)) return "namespace";
  if (Node.isVariableStatement(node)) return "variable";
  if (Node.isExportAssignment(node)) return "default-export";

  if (Node.isConstructorDeclaration(node)) return "constructor";
  if (Node.isGetAccessorDeclaration(node)) return "getter";
  if (Node.isSetAccessorDeclaration(node)) return "setter";
  if (Node.isMethodDeclaration(node) || Node.isMethodSignature(node)) return "method";
  if (Node.isPropertyDeclaration(node) || Node.isPropertySignature(node)) return "property";

  if (Node.isIndexSignatureDeclaration(node)) return "index-signature";
  if (Node.isCallSignatureDeclaration(node)) return "call-signature";
  if (Node.isConstructSignatureDeclaration(node)) return "construct-signature";

  return null;
}
