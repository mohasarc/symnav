import {
  Node,
  SyntaxKind,
  ts,
  type BinaryExpression,
  type PropertyAccessExpression,
  type SourceFile,
} from "ts-morph";
import type { LineRange } from "@symnav/core";

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
    if (Node.isPropertyAccessExpression(node)) {
      return JavaScriptAssignmentDeclarations.exportProperty(node);
    }
    return undefined;
  }

  private static exportProperty(
    target: PropertyAccessExpression,
  ): JavaScriptAssignmentDeclaration | undefined {
    const assignment = target.getParent();
    const isAssignmentTarget =
      JavaScriptAssignmentDeclarations.isAssignment(assignment) && assignment.getLeft() === target;
    if (!isAssignmentTarget) return undefined;
    if (!JavaScriptAssignmentDeclarations.isExportsObject(target.getExpression())) return undefined;
    const value = JavaScriptAssignmentDeclarations.assignedValue(assignment);
    if (JavaScriptAssignmentDeclarations.isVoidZero(value)) return undefined;
    const name = target.getName();
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
    return (
      Node.isPropertyAccessExpression(node) &&
      node.getName() === "exports" &&
      Node.isIdentifier(node.getExpression()) &&
      node.getExpression().getText() === "module"
    );
  }
}
