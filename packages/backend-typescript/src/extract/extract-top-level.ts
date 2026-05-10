import { Node, type SourceFile } from "ts-morph";
import type { SymbolDecl } from "@symnav/core";

import { extractChildren } from "./extract-children.js";
import { extractSignatureSource } from "./extract-signature-source.js";
import { nodeKind } from "./node-kind.js";
import { nodeName } from "./node-name.js";
import { nodeRange } from "./node-range.js";

export function extractTopLevel(sourceFile: SourceFile): readonly SymbolDecl[] {
  return sourceFile.getStatements().flatMap(toTopLevelDecls);
}

function toTopLevelDecls(stmt: Node): SymbolDecl[] {
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

function expandVariableStatement(stmt: Node): SymbolDecl[] {
  if (!Node.isVariableStatement(stmt)) return [];
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
  keyword: string,
  decl: { getName(): string; getTypeNode(): Node | undefined; getInitializer(): Node | undefined },
): string {
  const name = decl.getName();
  const typeNode = decl.getTypeNode();
  if (typeNode) return `${keyword} ${name}: ${typeNode.getText()}`;
  const initializer = decl.getInitializer();
  if (initializer) return `${keyword} ${name} = ${initializer.getText()}`;
  return `${keyword} ${name}`;
}
