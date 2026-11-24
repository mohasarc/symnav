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
    const [firstLine = ""] = JavaScriptDocDeclarations.tagSource(typeAlias).split(/\r?\n/);
    return firstLine.trimEnd();
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
}
