import type { VariableDeclaration, VariableStatement } from "ts-morph";

export interface ExtractVariableSignatureArgs {
  readonly statement: VariableStatement;
  readonly declaration: VariableDeclaration;
}

export function extractVariableSignature({
  statement,
  declaration,
}: ExtractVariableSignatureArgs): string {
  const keyword = statement.getDeclarationList().getDeclarationKind();
  const modifiers = statement
    .getModifiers()
    .map((modifier) => modifier.getText())
    .join(" ");
  const head = modifiers ? `${modifiers} ${keyword}` : keyword;
  return `${head} ${declaration.getText()}`;
}
