import {
  Node,
  SyntaxKind,
  ts,
  type BinaryExpression,
  type ElementAccessExpression,
  type PropertyAccessExpression,
  type SourceFile,
} from "ts-morph";
import { SEGMENT_SEPARATOR, parseSegment, type LineRange } from "@symnav/core";

import { collapseInitializerSource } from "./collapse-initializer-source.js";

export interface JavaScriptAssignmentDeclaration {
  readonly name: string;
  readonly declarationNode: Node;
  readonly value: Node;
  readonly statement: Node;
}

export class JavaScriptAssignmentDeclarations {
  static ofSourceFile(sourceFile: SourceFile): readonly JavaScriptAssignmentDeclaration[] {
    if (!JavaScriptAssignmentDeclarations.isJavaScriptFile(sourceFile)) return [];
    const declarations: JavaScriptAssignmentDeclaration[] = [];
    sourceFile.forEachDescendant((node) => {
      const declaration = JavaScriptAssignmentDeclarations.declarationOf(node);
      if (declaration) declarations.push(declaration);
    });
    return declarations;
  }

  static rangeOf(declaration: JavaScriptAssignmentDeclaration): LineRange {
    return {
      startLine: declaration.declarationNode.getStartLineNumber(),
      endLine: declaration.statement.getEndLineNumber(),
    };
  }

  static signatureOf(declaration: JavaScriptAssignmentDeclaration): string {
    const value = collapseInitializerSource(declaration.value);
    return `${declaration.declarationNode.getText()} = ${value}`;
  }

  private static isJavaScriptFile(sourceFile: SourceFile): boolean {
    return (sourceFile.compilerNode.flags & ts.NodeFlags.JavaScriptFile) !== 0;
  }

  private static declarationOf(node: Node): JavaScriptAssignmentDeclaration | undefined {
    if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
      return JavaScriptAssignmentDeclarations.exportProperty(node);
    }
    return undefined;
  }

  private static exportProperty(
    target: PropertyAccessExpression | ElementAccessExpression,
  ): JavaScriptAssignmentDeclaration | undefined {
    const assignment = target.getParent();
    const isAssignmentTarget =
      JavaScriptAssignmentDeclarations.isAssignment(assignment) && assignment.getLeft() === target;
    if (!isAssignmentTarget) return undefined;
    if (!JavaScriptAssignmentDeclarations.isExportsObject(target.getExpression())) return undefined;
    const value = JavaScriptAssignmentDeclarations.assignedValue(assignment);
    if (JavaScriptAssignmentDeclarations.isVoidZero(value)) return undefined;
    const name = JavaScriptAssignmentDeclarations.staticAccessName(target);
    if (name === undefined) return undefined;
    if (JavaScriptAssignmentDeclarations.aliasesSameNameLocal(value, name)) return undefined;
    const statement = target.getFirstAncestor(Node.isStatement);
    if (!statement) return undefined;
    return { name, declarationNode: target, value, statement };
  }

  private static assignedValue(assignment: BinaryExpression): Node {
    let value = assignment.getRight();
    while (JavaScriptAssignmentDeclarations.isAssignment(value)) value = value.getRight();
    return value;
  }

  private static isAssignment(node: Node | undefined): node is BinaryExpression {
    return (
      Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.EqualsToken
    );
  }

  private static isExportsObject(node: Node): boolean {
    return (
      JavaScriptAssignmentDeclarations.isExportsIdentifier(node) ||
      JavaScriptAssignmentDeclarations.isModuleExports(node)
    );
  }

  private static aliasesSameNameLocal(value: Node, name: string): boolean {
    return Node.isIdentifier(value) && value.getText() === name;
  }

  private static isVoidZero(value: Node): boolean {
    return Node.isVoidExpression(value) && value.getExpression().getText() === "0";
  }

  private static isExportsIdentifier(node: Node): boolean {
    return Node.isIdentifier(node) && node.getText() === "exports";
  }

  private static isModuleExports(node: Node): boolean {
    const isStaticAccess =
      Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node);
    if (!isStaticAccess) return false;
    const owner = node.getExpression();
    const ownerIsModule = Node.isIdentifier(owner) && owner.getText() === "module";
    return ownerIsModule && JavaScriptAssignmentDeclarations.staticAccessName(node) === "exports";
  }

  private static staticAccessName(
    access: PropertyAccessExpression | ElementAccessExpression,
  ): string | undefined {
    if (Node.isPropertyAccessExpression(access)) return access.getName();
    return JavaScriptAssignmentDeclarations.literalName(access.getArgumentExpression());
  }

  private static literalName(node: Node | undefined): string | undefined {
    const isLiteral =
      Node.isStringLiteral(node) ||
      Node.isNoSubstitutionTemplateLiteral(node) ||
      Node.isNumericLiteral(node);
    if (!isLiteral) return undefined;
    const name = node.compilerNode.text;
    return JavaScriptAssignmentDeclarations.spellsCanonicalSegment(name) ? name : undefined;
  }

  private static spellsCanonicalSegment(name: string): boolean {
    if (name.length === 0 || name.includes(SEGMENT_SEPARATOR)) return false;
    try {
      const segment = parseSegment(name, name);
      return segment.name === name && segment.disambiguator === undefined;
    } catch {
      return false;
    }
  }
}
