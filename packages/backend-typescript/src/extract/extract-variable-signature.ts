import type { VariableDeclaration, VariableStatement } from "ts-morph";

import { collapseInitializerSource } from "./collapse-initializer-source.js";

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
  return `${head} = ${collapseInitializerSource(initializer)}`;
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
