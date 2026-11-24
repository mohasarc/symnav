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
  type ShorthandPropertyAssignment,
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
  | "define-property-export"
  | "prototype-property"
  | "prototype-object-member"
  | "static-property"
  | "this-property";

export type JavaScriptDeclarationContainerScope = "module" | "enclosing-declaration";

interface SourceFileWithModuleIndicator extends ts.SourceFile {
  readonly externalModuleIndicator?: ts.Node | true;
}

interface BoundSourceFile extends ts.SourceFile {
  readonly symbol?: ts.Symbol;
}

export interface JavaScriptAssignmentDeclaration {
  readonly form: JavaScriptAssignmentDeclarationForm;
  readonly name: string;
  readonly declarationNode: Node;
  readonly nameNode: Node;
  readonly nameLiteral: Node | undefined;
  readonly value: Node;
  readonly statement: Node;
  readonly containerNames: readonly string[];
  readonly containerScope: JavaScriptDeclarationContainerScope;
}

export class JavaScriptAssignmentDeclarations {
  private static readonly MODULE_LEVEL = {
    containerNames: [],
    containerScope: "module",
  } as const satisfies Pick<JavaScriptAssignmentDeclaration, "containerNames" | "containerScope">;

  static ofSourceFile(sourceFile: SourceFile): readonly JavaScriptAssignmentDeclaration[] {
    if (!JavaScriptAssignmentDeclarations.isCommonJsFile(sourceFile)) return [];
    const declarations: JavaScriptAssignmentDeclaration[] = [];
    sourceFile.forEachDescendant((node) => {
      const declaration = JavaScriptAssignmentDeclarations.commonJsDeclarationOf(node);
      if (declaration) declarations.push(declaration);
    });
    return declarations;
  }

  static declarationAt(node: Node): JavaScriptAssignmentDeclaration | undefined {
    const sourceFile = node.getSourceFile();
    if (!JavaScriptAssignmentDeclarations.isJavaScriptFile(sourceFile)) return undefined;
    const commonJsDeclaration = JavaScriptAssignmentDeclarations.isCommonJsFile(sourceFile)
      ? JavaScriptAssignmentDeclarations.commonJsDeclarationOf(node)
      : undefined;
    return commonJsDeclaration ?? JavaScriptAssignmentDeclarations.expandoDeclarationOf(node);
  }

  static isJavaScriptFile(sourceFile: SourceFile): boolean {
    return (sourceFile.compilerNode.flags & ts.NodeFlags.JavaScriptFile) !== 0;
  }

  static rangeOf(declaration: JavaScriptAssignmentDeclaration): LineRange {
    const { declarationNode } = declaration;
    const extent = JavaScriptAssignmentDeclarations.isObjectMemberDeclaration(declaration)
      ? declarationNode
      : declaration.statement;
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
    if (Node.isShorthandPropertyAssignment(declarationNode)) return declarationNode.getText();
    if (JavaScriptAssignmentDeclarations.isObjectMemberDeclaration(declaration)) {
      return extractSignatureSource(declarationNode);
    }
    if (Node.isCallExpression(declarationNode)) {
      return JavaScriptAssignmentDeclarations.definePropertySignature(declarationNode);
    }
    return `${declarationNode.getText()} = ${value}`;
  }

  private static isObjectMemberDeclaration(declaration: JavaScriptAssignmentDeclaration): boolean {
    return (
      declaration.form === "module-exports-member" || declaration.form === "prototype-object-member"
    );
  }

  private static isCommonJsFile(sourceFile: SourceFile): boolean {
    return (
      JavaScriptAssignmentDeclarations.isJavaScriptFile(sourceFile) &&
      !JavaScriptAssignmentDeclarations.hasModuleSyntax(sourceFile)
    );
  }

  private static hasModuleSyntax(sourceFile: SourceFile): boolean {
    const { externalModuleIndicator } = sourceFile.compilerNode as SourceFileWithModuleIndicator;
    return externalModuleIndicator !== undefined && externalModuleIndicator !== true;
  }

  private static commonJsDeclarationOf(node: Node): JavaScriptAssignmentDeclaration | undefined {
    if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
      if (JavaScriptAssignmentDeclarations.isModuleExports(node)) {
        return JavaScriptAssignmentDeclarations.moduleExportsValue(node);
      }
      return (
        JavaScriptAssignmentDeclarations.exportProperty(node) ??
        JavaScriptAssignmentDeclarations.moduleThisExport(node)
      );
    }
    if (JavaScriptAssignmentDeclarations.isObjectMember(node)) {
      return JavaScriptAssignmentDeclarations.moduleExportsMember(node);
    }
    if (Node.isCallExpression(node)) return JavaScriptAssignmentDeclarations.definedExport(node);
    return undefined;
  }

  private static expandoDeclarationOf(node: Node): JavaScriptAssignmentDeclaration | undefined {
    if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
      return (
        JavaScriptAssignmentDeclarations.prototypeProperty(node) ??
        JavaScriptAssignmentDeclarations.staticProperty(node) ??
        JavaScriptAssignmentDeclarations.thisProperty(node)
      );
    }
    const isPrototypeObjectMemberCandidate =
      JavaScriptAssignmentDeclarations.isObjectMember(node) ||
      Node.isShorthandPropertyAssignment(node);
    if (isPrototypeObjectMemberCandidate) {
      return JavaScriptAssignmentDeclarations.prototypeObjectMember(node);
    }
    if (Node.isCallExpression(node)) return JavaScriptAssignmentDeclarations.definedMember(node);
    return undefined;
  }

  private static definedMember(call: CallExpression): JavaScriptAssignmentDeclaration | undefined {
    if (!JavaScriptAssignmentDeclarations.isDefinePropertyCall(call)) return undefined;
    const [owner, nameArgument, descriptor] = call.getArguments();
    if (!owner || !nameArgument || !descriptor) return undefined;
    const prototypeContainerNames = JavaScriptAssignmentDeclarations.prototypeContainerNames(owner);
    const containerNames =
      prototypeContainerNames ?? JavaScriptAssignmentDeclarations.bindableNames(owner);
    const name = JavaScriptAssignmentDeclarations.literalName(nameArgument);
    const statement = call.getFirstAncestor(Node.isStatement);
    if (!containerNames || name === undefined || !statement) return undefined;
    return {
      form: prototypeContainerNames ? "prototype-property" : "static-property",
      name,
      declarationNode: call,
      nameNode: nameArgument,
      nameLiteral: nameArgument,
      value: JavaScriptAssignmentDeclarations.descriptorValue(descriptor),
      statement,
      containerNames,
      containerScope: "enclosing-declaration",
    };
  }

  private static prototypeObjectMember(
    member: ObjectMember | ShorthandPropertyAssignment,
  ): JavaScriptAssignmentDeclaration | undefined {
    const object = member.getParent();
    const assignment = object.getParent();
    const assignsObject =
      JavaScriptAssignmentDeclarations.isAssignment(assignment) && assignment.getRight() === object;
    if (!assignsObject) return undefined;
    const containerNames = JavaScriptAssignmentDeclarations.prototypeContainerNames(
      assignment.getLeft(),
    );
    const nameNode = member.getNameNode();
    const name = JavaScriptAssignmentDeclarations.propertyName(nameNode);
    const statement = member.getFirstAncestor(Node.isStatement);
    if (!containerNames || name === undefined || !statement) return undefined;
    return {
      form: "prototype-object-member",
      name,
      declarationNode: member,
      nameNode,
      nameLiteral: JavaScriptAssignmentDeclarations.propertyNameLiteral(nameNode),
      value: Node.isPropertyAssignment(member) ? member.getInitializerOrThrow() : member,
      statement,
      containerNames,
      containerScope: "enclosing-declaration",
    };
  }

  private static prototypeProperty(
    target: PropertyAccessExpression | ElementAccessExpression,
  ): JavaScriptAssignmentDeclaration | undefined {
    const containerNames = JavaScriptAssignmentDeclarations.prototypeContainerNames(
      target.getExpression(),
    );
    const assigned = JavaScriptAssignmentDeclarations.assignedTo(target);
    const name = JavaScriptAssignmentDeclarations.staticAccessName(target);
    if (!containerNames || !assigned || name === undefined) return undefined;
    return {
      form: "prototype-property",
      name,
      declarationNode: target,
      nameNode: target,
      nameLiteral: Node.isElementAccessExpression(target)
        ? target.getArgumentExpression()
        : undefined,
      ...assigned,
      containerNames,
      containerScope: "enclosing-declaration",
    };
  }

  private static staticProperty(
    target: PropertyAccessExpression | ElementAccessExpression,
  ): JavaScriptAssignmentDeclaration | undefined {
    const ownerNames = JavaScriptAssignmentDeclarations.bindableNames(target.getExpression());
    const assigned = JavaScriptAssignmentDeclarations.assignedTo(target);
    const name = JavaScriptAssignmentDeclarations.staticAccessName(target);
    if (!ownerNames || !assigned || name === undefined) return undefined;
    const assignsPrototypeObject =
      name === "prototype" && Node.isObjectLiteralExpression(assigned.value);
    if (assignsPrototypeObject) return undefined;
    const container = JavaScriptAssignmentDeclarations.staticContainer(ownerNames);
    if (!container) return undefined;
    return {
      form: "static-property",
      name,
      declarationNode: target,
      nameNode: target,
      nameLiteral: Node.isElementAccessExpression(target)
        ? target.getArgumentExpression()
        : undefined,
      ...assigned,
      ...container,
    };
  }

  private static thisProperty(
    target: PropertyAccessExpression | ElementAccessExpression,
  ): JavaScriptAssignmentDeclaration | undefined {
    const assignsThisMember =
      Node.isThisExpression(target.getExpression()) &&
      !(Node.isPropertyAccessExpression(target) && Node.isPrivateIdentifier(target.getNameNode()));
    if (!assignsThisMember) return undefined;
    const assigned = JavaScriptAssignmentDeclarations.assignedTo(target);
    const name = JavaScriptAssignmentDeclarations.staticAccessName(target);
    const thisContainer = JavaScriptAssignmentDeclarations.thisContainerOf(target);
    const member = thisContainer && JavaScriptAssignmentDeclarations.thisMemberOf(thisContainer);
    if (!assigned || name === undefined || !member) return undefined;
    return {
      ...member,
      name,
      declarationNode: target,
      nameNode: target,
      nameLiteral: Node.isElementAccessExpression(target)
        ? target.getArgumentExpression()
        : undefined,
      ...assigned,
      containerScope: "enclosing-declaration",
    };
  }

  private static thisContainerOf(node: Node): Node | undefined {
    for (let parent = node.getParent(); parent; parent = parent.getParent()) {
      if (JavaScriptAssignmentDeclarations.isThisContainer(parent)) return parent;
    }
    return undefined;
  }

  private static isThisContainer(node: Node): boolean {
    return (
      Node.isFunctionDeclaration(node) ||
      Node.isFunctionExpression(node) ||
      Node.isConstructorDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node) ||
      Node.isPropertyDeclaration(node) ||
      Node.isClassStaticBlockDeclaration(node) ||
      Node.isModuleDeclaration(node) ||
      Node.isSourceFile(node)
    );
  }

  private static thisMemberOf(
    thisContainer: Node,
  ): Pick<JavaScriptAssignmentDeclaration, "form" | "containerNames"> | undefined {
    const isFunctionContainer =
      Node.isFunctionDeclaration(thisContainer) || Node.isFunctionExpression(thisContainer);
    if (isFunctionContainer) {
      const containerNames =
        JavaScriptAssignmentDeclarations.prototypeMethodContainerNames(thisContainer) ??
        JavaScriptAssignmentDeclarations.ownerNamesOf(thisContainer);
      return containerNames ? { form: "this-property", containerNames } : undefined;
    }
    const owner = thisContainer.getParent();
    if (!Node.isClassDeclaration(owner) && !Node.isClassExpression(owner)) return undefined;
    const containerNames = JavaScriptAssignmentDeclarations.ownerNamesOf(owner);
    if (!containerNames) return undefined;
    const isStaticMember =
      Node.isClassStaticBlockDeclaration(thisContainer) ||
      (Node.isStaticable(thisContainer) && thisContainer.isStatic());
    return { form: isStaticMember ? "static-property" : "this-property", containerNames };
  }

  private static prototypeMethodContainerNames(method: Node): readonly string[] | undefined {
    const assignment = method.getParent();
    const isPrototypeMethod =
      JavaScriptAssignmentDeclarations.isAssignment(assignment) && assignment.getRight() === method;
    if (!isPrototypeMethod) return undefined;
    const target = assignment.getLeft();
    const isStaticAccess =
      Node.isPropertyAccessExpression(target) || Node.isElementAccessExpression(target);
    return isStaticAccess
      ? JavaScriptAssignmentDeclarations.prototypeContainerNames(target.getExpression())
      : undefined;
  }

  private static ownerNamesOf(declaration: Node): readonly string[] | undefined {
    const name = Node.hasName(declaration) ? declaration.getName() : undefined;
    if (name) return [name];
    let parent = declaration.getParent();
    while (Node.isParenthesizedExpression(parent)) parent = parent.getParent();
    if (Node.isVariableDeclaration(parent)) return [parent.getName()];
    if (JavaScriptAssignmentDeclarations.isAssignment(parent)) {
      return JavaScriptAssignmentDeclarations.bindableNames(parent.getLeft());
    }
    return undefined;
  }

  private static staticContainer(
    ownerNames: readonly string[],
  ): Pick<JavaScriptAssignmentDeclaration, "containerNames" | "containerScope"> | undefined {
    const exportsRootLength = JavaScriptAssignmentDeclarations.exportsRootLength(ownerNames);
    if (exportsRootLength === 0) {
      return { containerNames: ownerNames, containerScope: "enclosing-declaration" };
    }
    const containerNames = ownerNames.slice(exportsRootLength);
    return containerNames.length > 0 ? { containerNames, containerScope: "module" } : undefined;
  }

  private static exportsRootLength(ownerNames: readonly string[]): number {
    if (ownerNames[0] === "exports") return 1;
    const isModuleExportsRoot = ownerNames[0] === "module" && ownerNames[1] === "exports";
    return isModuleExportsRoot ? 2 : 0;
  }

  private static prototypeContainerNames(prototypeAccess: Node): readonly string[] | undefined {
    const accessesPrototype =
      (Node.isPropertyAccessExpression(prototypeAccess) ||
        Node.isElementAccessExpression(prototypeAccess)) &&
      JavaScriptAssignmentDeclarations.staticAccessName(prototypeAccess) === "prototype";
    if (!accessesPrototype) return undefined;
    return JavaScriptAssignmentDeclarations.bindableNames(prototypeAccess.getExpression());
  }

  private static bindableNames(expression: Node): readonly string[] | undefined {
    if (Node.isIdentifier(expression)) return [expression.getText()];
    const isStaticAccess =
      Node.isPropertyAccessExpression(expression) || Node.isElementAccessExpression(expression);
    if (!isStaticAccess) return undefined;
    const ownerNames = JavaScriptAssignmentDeclarations.bindableNames(expression.getExpression());
    const name = JavaScriptAssignmentDeclarations.staticAccessName(expression);
    return ownerNames && name !== undefined ? [...ownerNames, name] : undefined;
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
      ...JavaScriptAssignmentDeclarations.MODULE_LEVEL,
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
      ...JavaScriptAssignmentDeclarations.MODULE_LEVEL,
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
      ...JavaScriptAssignmentDeclarations.MODULE_LEVEL,
    };
  }

  private static moduleThisExport(
    target: PropertyAccessExpression | ElementAccessExpression,
  ): JavaScriptAssignmentDeclaration | undefined {
    if (!Node.isThisExpression(target.getExpression())) return undefined;
    const assigned = JavaScriptAssignmentDeclarations.assignedTo(target);
    const name = JavaScriptAssignmentDeclarations.staticAccessName(target);
    if (!assigned || name === undefined) return undefined;
    const declaresExport = JavaScriptAssignmentDeclarations.isBoundModuleExport(target, name);
    if (!declaresExport) return undefined;
    return {
      form: "export-property",
      name,
      declarationNode: target,
      nameNode: target,
      nameLiteral: Node.isElementAccessExpression(target)
        ? target.getArgumentExpression()
        : undefined,
      ...assigned,
      ...JavaScriptAssignmentDeclarations.MODULE_LEVEL,
    };
  }

  private static isBoundModuleExport(
    target: PropertyAccessExpression | ElementAccessExpression,
    name: string,
  ): boolean {
    const sourceFile = target.getSourceFile().compilerNode as BoundSourceFile;
    const exported = sourceFile.symbol?.exports?.get(ts.escapeLeadingUnderscores(name));
    const assignment = target.getParentOrThrow().compilerNode as ts.Declaration;
    return exported?.declarations?.includes(assignment) ?? false;
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
      ...JavaScriptAssignmentDeclarations.MODULE_LEVEL,
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
