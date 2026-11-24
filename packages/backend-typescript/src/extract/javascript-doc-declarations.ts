import { Node, ts, type Identifier, type JSDocCallbackTag, type JSDocTypedefTag } from "ts-morph";
import type { LineRange } from "@symnav/core";

import { JavaScriptAssignmentDeclarations } from "./javascript-assignment-declaration.js";

interface JSDocHostNode extends ts.Node {
  readonly jsDoc?: readonly ts.JSDoc[];
}

export interface JavaScriptDocTypeAlias {
  readonly name: string;
  readonly nameNode: Identifier;
  readonly tag: JSDocTypedefTag | JSDocCallbackTag;
}

export class JavaScriptDocDeclarations {
  private static readonly TRAILING_COMMENT_DECORATION = /[\s*]+$/;

  static typeAliasesOf(host: Node): readonly JavaScriptDocTypeAlias[] {
    const hasJSDoc = ((host.compilerNode as JSDocHostNode).jsDoc?.length ?? 0) > 0;
    if (!hasJSDoc) return [];
    if (!JavaScriptAssignmentDeclarations.isJavaScriptFile(host.getSourceFile())) return [];
    return host
      .getChildren()
      .filter(Node.isJSDoc)
      .flatMap((comment) => comment.getTags())
      .flatMap((tag) => {
        const typeAlias = JavaScriptDocDeclarations.typeAliasOf(tag);
        return typeAlias ? [typeAlias] : [];
      });
  }

  static isEnumDeclaration(declaration: Node): boolean {
    const isJavaScript = JavaScriptAssignmentDeclarations.isJavaScriptFile(
      declaration.getSourceFile(),
    );
    if (!isJavaScript) return false;
    const enumHost =
      JavaScriptDocDeclarations.enumVariableStatement(declaration) ??
      JavaScriptDocDeclarations.enumAssignmentStatement(declaration);
    return enumHost !== undefined && JavaScriptDocDeclarations.hasEnumTag(enumHost);
  }

  static typeAliasNamedBy(nameNode: Node): JavaScriptDocTypeAlias | undefined {
    const tag = nameNode.getParent();
    const typeAlias = tag && JavaScriptDocDeclarations.typeAliasOf(tag);
    return typeAlias?.nameNode.compilerNode === nameNode.compilerNode ? typeAlias : undefined;
  }

  static rangeOf(typeAlias: JavaScriptDocTypeAlias): LineRange {
    const { tag } = typeAlias;
    const lastCharacter =
      tag.getStart() + JavaScriptDocDeclarations.tagSource(typeAlias).length - 1;
    return {
      startLine: tag.getStartLineNumber(),
      endLine: tag.getSourceFile().getLineAndColumnAtPos(lastCharacter).line,
    };
  }

  static signatureOf(typeAlias: JavaScriptDocTypeAlias): string {
    const { tag, name } = typeAlias;
    if (JavaScriptDocDeclarations.hasMultiLineTypeExpression(tag)) {
      return `@${tag.getTagName()} {…} ${name}`;
    }
    const [firstLine = ""] = JavaScriptDocDeclarations.tagSource(typeAlias).split(/\r?\n/);
    return firstLine.trimEnd();
  }

  private static hasMultiLineTypeExpression(tag: JSDocTypedefTag | JSDocCallbackTag): boolean {
    const typeExpression = tag.compilerNode.typeExpression;
    if (!typeExpression || !ts.isJSDocTypeExpression(typeExpression)) return false;
    const sourceFile = tag.getSourceFile();
    const startLine = sourceFile.getLineAndColumnAtPos(
      typeExpression.getStart(sourceFile.compilerNode),
    ).line;
    const endLine = sourceFile.getLineAndColumnAtPos(typeExpression.getEnd()).line;
    return startLine !== endLine;
  }

  private static tagSource(typeAlias: JavaScriptDocTypeAlias): string {
    return typeAlias.tag
      .getText()
      .replace(JavaScriptDocDeclarations.TRAILING_COMMENT_DECORATION, "");
  }

  private static typeAliasOf(tag: Node): JavaScriptDocTypeAlias | undefined {
    if (!Node.isJSDocTypedefTag(tag) && !Node.isJSDocCallbackTag(tag)) return undefined;
    const nameNode = tag.getNodeProperty("fullName");
    if (!Node.isIdentifier(nameNode)) return undefined;
    return { name: nameNode.getText(), nameNode, tag };
  }

  private static enumVariableStatement(declaration: Node): Node | undefined {
    if (!Node.isVariableDeclaration(declaration)) return undefined;
    const statement = declaration.getVariableStatement();
    const namesStatement = statement?.getDeclarations()[0] === declaration;
    return namesStatement ? statement : undefined;
  }

  private static enumAssignmentStatement(target: Node): Node | undefined {
    if (!Node.isPropertyAccessExpression(target)) return undefined;
    const assignment = target.getParent();
    const statement = assignment?.getParent();
    const isTopLevelAssignment =
      Node.isBinaryExpression(assignment) &&
      assignment.getOperatorToken().getKind() === ts.SyntaxKind.EqualsToken &&
      assignment.getLeft() === target &&
      Node.isExpressionStatement(statement) &&
      Node.isSourceFile(statement.getParent());
    if (!isTopLevelAssignment) return undefined;
    const owner = target.getExpression();
    const ownerMergesEnum =
      Node.isIdentifier(owner) || JavaScriptDocDeclarations.isModuleExports(owner);
    return ownerMergesEnum ? statement : undefined;
  }

  private static isModuleExports(node: Node): boolean {
    return (
      Node.isPropertyAccessExpression(node) &&
      node.getName() === "exports" &&
      node.getExpression().getText() === "module"
    );
  }

  private static hasEnumTag(host: Node): boolean {
    const comments = (host.compilerNode as JSDocHostNode).jsDoc ?? [];
    return comments.some((comment) => comment.tags?.some(ts.isJSDocEnumTag) ?? false);
  }
}
