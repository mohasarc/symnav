import {
  Node,
  SyntaxKind,
  ts,
  type BinaryExpression,
  type CallExpression,
  type ElementAccessExpression,
  type GetAccessorDeclaration,
  type MethodDeclaration,
  type PropertyAccessExpression,
  type PropertyAssignment,
  type SetAccessorDeclaration,
  type SourceFile,
} from "ts-morph";
import { SEGMENT_SEPARATOR, parseSegment, type LineRange } from "@symnav/core";

import { collapseInitializerSource } from "./collapse-initializer-source.js";
import { extractSignatureSource } from "./extract-signature-source.js";

const DEFINE_PROPERTY_ARITY = 3;

type ObjectMember =
  | PropertyAssignment
  | MethodDeclaration
  | GetAccessorDeclaration
  | SetAccessorDeclaration;

export type JavaScriptAssignmentDeclarationForm =
  | "export-property"
  | "module-exports-member"
  | "module-exports"
  | "define-property-export";

interface SourceFileWithModuleIndicator extends ts.SourceFile {
  readonly externalModuleIndicator?: ts.Node | true;
}

export interface JavaScriptAssignmentDeclaration {
  readonly form: JavaScriptAssignmentDeclarationForm;
  readonly name: string;
  readonly declarationNode: Node;
  readonly nameNode: Node;
  readonly nameLiteral: Node | undefined;
  readonly value: Node;
  readonly statement: Node;
}

export class JavaScriptAssignmentDeclarations {
  static ofSourceFile(sourceFile: SourceFile): readonly JavaScriptAssignmentDeclaration[] {
    if (!JavaScriptAssignmentDeclarations.isCommonJsFile(sourceFile)) return [];
    const declarations: JavaScriptAssignmentDeclaration[] = [];
    sourceFile.forEachDescendant((node) => {
      const declaration = JavaScriptAssignmentDeclarations.declarationOf(node);
      if (declaration) declarations.push(declaration);
    });
    return declarations;
  }

  static declarationAt(node: Node): JavaScriptAssignmentDeclaration | undefined {
    if (!JavaScriptAssignmentDeclarations.isCommonJsFile(node.getSourceFile())) return undefined;
    return JavaScriptAssignmentDeclarations.declarationOf(node);
  }

  static rangeOf(declaration: JavaScriptAssignmentDeclaration): LineRange {
    const { declarationNode } = declaration;
    const extent =
      declaration.form === "module-exports-member" ? declarationNode : declaration.statement;
    return {
      startLine: declarationNode.getStartLineNumber(),
      endLine: extent.getEndLineNumber(),
    };
  }

  static signatureOf(declaration: JavaScriptAssignmentDeclaration): string {
    const { declarationNode } = declaration;
    const value = collapseInitializerSource(declaration.value);
    if (Node.isPropertyAssignment(declarationNode)) {
      return `${declarationNode.getNameNode().getText()}: ${value}`;
    }
    if (declaration.form === "module-exports-member") {
      return extractSignatureSource(declarationNode);
    }
    if (Node.isCallExpression(declarationNode)) {
      return JavaScriptAssignmentDeclarations.definePropertySignature(declarationNode);
    }
    return `${declarationNode.getText()} = ${value}`;
  }

  private static isCommonJsFile(sourceFile: SourceFile): boolean {
    const isJavaScriptFile = (sourceFile.compilerNode.flags & ts.NodeFlags.JavaScriptFile) !== 0;
    return isJavaScriptFile && !JavaScriptAssignmentDeclarations.hasModuleSyntax(sourceFile);
  }

  private static hasModuleSyntax(sourceFile: SourceFile): boolean {
    const { externalModuleIndicator } = sourceFile.compilerNode as SourceFileWithModuleIndicator;
    return externalModuleIndicator !== undefined && externalModuleIndicator !== true;
  }

  private static declarationOf(node: Node): JavaScriptAssignmentDeclaration | undefined {
    if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
      return JavaScriptAssignmentDeclarations.isModuleExports(node)
        ? JavaScriptAssignmentDeclarations.moduleExportsValue(node)
        : JavaScriptAssignmentDeclarations.exportProperty(node);
    }
    if (JavaScriptAssignmentDeclarations.isObjectMember(node)) {
      return JavaScriptAssignmentDeclarations.moduleExportsMember(node);
    }
    if (Node.isCallExpression(node)) return JavaScriptAssignmentDeclarations.definedExport(node);
    return undefined;
  }

  private static definedExport(call: CallExpression): JavaScriptAssignmentDeclaration | undefined {
    if (!JavaScriptAssignmentDeclarations.isDefinePropertyCall(call)) return undefined;
    const [owner, nameArgument, descriptor] = call.getArguments();
    const definesExport =
      owner !== undefined && JavaScriptAssignmentDeclarations.isExportsObject(owner);
    if (!definesExport || !nameArgument || !descriptor) return undefined;
    const name = JavaScriptAssignmentDeclarations.literalName(nameArgument);
    const statement = call.getFirstAncestor(Node.isStatement);
    if (name === undefined || !statement) return undefined;
    return {
      form: "define-property-export",
      name,
      declarationNode: call,
      nameNode: nameArgument,
      nameLiteral: nameArgument,
      value: JavaScriptAssignmentDeclarations.descriptorValue(descriptor),
      statement,
    };
  }

  private static isDefinePropertyCall(call: CallExpression): boolean {
    const callee = call.getExpression();
    const callsObjectDefineProperty =
      Node.isPropertyAccessExpression(callee) &&
      callee.getName() === "defineProperty" &&
      callee.getExpression().getText() === "Object";
    return callsObjectDefineProperty && call.getArguments().length === DEFINE_PROPERTY_ARITY;
  }

  private static descriptorValue(descriptor: Node): Node {
    if (!Node.isObjectLiteralExpression(descriptor)) return descriptor;
    const valueProperty = descriptor.getProperty("value");
    if (!Node.isPropertyAssignment(valueProperty)) return descriptor;
    return valueProperty.getInitializer() ?? descriptor;
  }

  private static definePropertySignature(call: CallExpression): string {
    const [owner, nameArgument, descriptor] = call.getArguments();
    const descriptorSource = descriptor ? collapseInitializerSource(descriptor) : "";
    return `${call.getExpression().getText()}(${owner?.getText()}, ${nameArgument?.getText()}, ${descriptorSource})`;
  }

  private static moduleExportsMember(
    member: ObjectMember,
  ): JavaScriptAssignmentDeclaration | undefined {
    const object = member.getParent();
    const isModuleExportsObject =
      Node.isObjectLiteralExpression(object) &&
      JavaScriptAssignmentDeclarations.assignsModuleExports(object);
    if (!isModuleExportsObject) return undefined;
    const nameNode = member.getNameNode();
    const name = JavaScriptAssignmentDeclarations.propertyName(nameNode);
    if (name === undefined) return undefined;
    const value = Node.isPropertyAssignment(member) ? member.getInitializer() : member;
    const statement = member.getFirstAncestor(Node.isStatement);
    if (!value || !statement) return undefined;
    return {
      form: "module-exports-member",
      name,
      declarationNode: member,
      nameNode,
      nameLiteral: JavaScriptAssignmentDeclarations.propertyNameLiteral(nameNode),
      value,
      statement,
    };
  }

  private static assignsModuleExports(object: Node): boolean {
    let assigned = object;
    let parent = object.getParent();
    while (parent) {
      const assignsThroughParent =
        Node.isParenthesizedExpression(parent) ||
        (JavaScriptAssignmentDeclarations.isAssignment(parent) && parent.getRight() === assigned);
      if (!assignsThroughParent) return false;
      const assignsModuleExports =
        JavaScriptAssignmentDeclarations.isAssignment(parent) &&
        JavaScriptAssignmentDeclarations.isModuleExports(parent.getLeft());
      if (assignsModuleExports) return true;
      assigned = parent;
      parent = parent.getParent();
    }
    return false;
  }

  private static isObjectMember(node: Node): node is ObjectMember {
    return (
      Node.isPropertyAssignment(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node)
    );
  }

  private static propertyName(nameNode: Node): string | undefined {
    if (Node.isIdentifier(nameNode)) return nameNode.getText();
    return JavaScriptAssignmentDeclarations.literalName(
      JavaScriptAssignmentDeclarations.propertyNameLiteral(nameNode),
    );
  }

  private static propertyNameLiteral(nameNode: Node): Node | undefined {
    if (Node.isIdentifier(nameNode)) return undefined;
    return Node.isComputedPropertyName(nameNode) ? nameNode.getExpression() : nameNode;
  }

  private static exportProperty(
    target: PropertyAccessExpression | ElementAccessExpression,
  ): JavaScriptAssignmentDeclaration | undefined {
    if (!JavaScriptAssignmentDeclarations.isExportsObject(target.getExpression())) return undefined;
    const assigned = JavaScriptAssignmentDeclarations.assignedTo(target);
    if (!assigned) return undefined;
    const name = JavaScriptAssignmentDeclarations.staticAccessName(target);
    if (name === undefined) return undefined;
    if (JavaScriptAssignmentDeclarations.aliasesSameNameLocal(assigned.value, name)) {
      return undefined;
    }
    const nameLiteral = Node.isElementAccessExpression(target)
      ? target.getArgumentExpression()
      : undefined;
    return {
      form: "export-property",
      name,
      declarationNode: target,
      nameNode: target,
      nameLiteral,
      ...assigned,
    };
  }

  private static moduleExportsValue(
    target: PropertyAccessExpression | ElementAccessExpression,
  ): JavaScriptAssignmentDeclaration | undefined {
    const assigned = JavaScriptAssignmentDeclarations.assignedTo(target);
    if (!assigned) return undefined;
    const value = JavaScriptAssignmentDeclarations.withoutParentheses(assigned.value);
    const assignsObjectOrItself =
      Node.isObjectLiteralExpression(value) ||
      JavaScriptAssignmentDeclarations.isExportsObject(value);
    if (assignsObjectOrItself) return undefined;
    return {
      form: "module-exports",
      name: "default",
      declarationNode: target,
      nameNode: target,
      nameLiteral: undefined,
      ...assigned,
    };
  }

  private static assignedTo(target: Node): { value: Node; statement: Node } | undefined {
    const assignment = target.getParent();
    const isAssignmentTarget =
      JavaScriptAssignmentDeclarations.isAssignment(assignment) && assignment.getLeft() === target;
    if (!isAssignmentTarget) return undefined;
    const value = JavaScriptAssignmentDeclarations.assignedValue(assignment);
    if (JavaScriptAssignmentDeclarations.isVoidZero(value)) return undefined;
    const statement = target.getFirstAncestor(Node.isStatement);
    return statement ? { value, statement } : undefined;
  }

  private static withoutParentheses(expression: Node): Node {
    return Node.isParenthesizedExpression(expression)
      ? JavaScriptAssignmentDeclarations.withoutParentheses(expression.getExpression())
      : expression;
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
