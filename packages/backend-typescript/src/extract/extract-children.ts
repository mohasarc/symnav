import {
  Node,
  type VariableDeclaration,
  type VariableDeclarationKind,
  type VariableStatement,
} from "ts-morph";
import type { LineRange, SymbolDecl } from "@symnav/core";

import { extractSignatureSource } from "./extract-signature-source.js";
import { nodeKind } from "./node-kind.js";

export function extractChildren(parent: Node): readonly SymbolDecl[] {
  if (Node.isClassDeclaration(parent)) {
    return parent.getMembers().flatMap(toMemberDecl);
  }
  if (Node.isInterfaceDeclaration(parent)) {
    return parent.getMembers().flatMap(toMemberDecl);
  }
  if (Node.isModuleDeclaration(parent)) {
    return extractStatementDecls(parent.getStatements());
  }
  return [];
}

export function extractStatementDecls(statements: readonly Node[]): readonly SymbolDecl[] {
  return statements.flatMap(toStatementDecl);
}

function toMemberDecl(member: Node): SymbolDecl[] {
  const kind = nodeKind(member);
  if (!kind) return [];
  return [
    {
      kind,
      name: nodeName(member),
      range: nodeRange(member),
      signatureSource: extractSignatureSource(member),
      children: [],
    },
  ];
}

function toStatementDecl(stmt: Node): SymbolDecl[] {
  const kind = nodeKind(stmt);
  if (!kind) return [];
  if (Node.isVariableStatement(stmt)) {
    return expandVariableStatement(stmt);
  }
  return [
    {
      kind,
      name: nodeName(stmt),
      range: nodeRange(stmt),
      signatureSource: extractSignatureSource(stmt),
      children: extractChildren(stmt),
    },
  ];
}

function expandVariableStatement(stmt: VariableStatement): SymbolDecl[] {
  const declList = stmt.getDeclarationList();
  const keyword = declList.getDeclarationKind();
  return declList.getDeclarations().map((decl) => ({
    kind: "variable" as const,
    name: decl.getName(),
    range: nodeRange(stmt),
    signatureSource: singleVariableSignature(keyword, decl),
    children: [],
  }));
}

function singleVariableSignature(
  keyword: VariableDeclarationKind,
  decl: VariableDeclaration,
): string {
  const name = decl.getName();
  const typeNode = decl.getTypeNode();
  if (typeNode) return `${keyword} ${name}: ${typeNode.getText()}`;
  const initializer = decl.getInitializer();
  if (initializer) return `${keyword} ${name} = ${initializer.getText()}`;
  return `${keyword} ${name}`;
}

function nodeName(node: Node): string {
  if (Node.isConstructorDeclaration(node)) return "constructor";
  if (Node.isCallSignatureDeclaration(node)) return "()";
  if (Node.isConstructSignatureDeclaration(node)) return "new()";
  if (Node.isIndexSignatureDeclaration(node)) return "[index]";
  if (Node.isExportAssignment(node)) return "default";

  if (
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isModuleDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isMethodSignature(node) ||
    Node.isPropertySignature(node)
  ) {
    return node.getName() ?? "";
  }

  return "";
}

function nodeRange(node: Node): LineRange {
  return {
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
  };
}
