import { Node, ts, type SourceFile } from "ts-morph";

import {
  JavaScriptAssignmentDeclarations,
  type JavaScriptAssignmentDeclaration,
} from "./javascript-assignment-declaration.js";

interface BoundNode extends ts.Node {
  readonly symbol?: ts.Symbol;
}

interface TypeScriptBinder {
  bindSourceFile(file: ts.SourceFile, options: ts.CompilerOptions): void;
}

export class JavaScriptExpandoMembers {
  private static readonly BINDER_OPTIONS: ts.CompilerOptions = {};
  private static readonly PROTOTYPE = "prototype" as ts.__String;

  private constructor(private readonly sourceFile: SourceFile) {}

  static of(sourceFile: SourceFile): JavaScriptExpandoMembers | undefined {
    if (!JavaScriptAssignmentDeclarations.isJavaScriptFile(sourceFile)) return undefined;
    const binder = ts as unknown as TypeScriptBinder;
    binder.bindSourceFile(sourceFile.compilerNode, JavaScriptExpandoMembers.BINDER_OPTIONS);
    return new JavaScriptExpandoMembers(sourceFile);
  }

  membersOf(container: Node): readonly JavaScriptAssignmentDeclaration[] {
    const symbol = JavaScriptExpandoMembers.declaredSymbolOf(container);
    if (!symbol) return [];
    const prototype = symbol.exports?.get(JavaScriptExpandoMembers.PROTOTYPE);
    return [
      ...[...(symbol.members?.values() ?? []), ...(symbol.exports?.values() ?? [])].flatMap(
        (member) => this.declaredMembers(member),
      ),
      ...(prototype?.declarations ?? []).flatMap((declaration) =>
        this.prototypeObjectMembers(declaration),
      ),
      ...this.functionValueMembers(container, symbol),
    ].sort((left, right) => left.declarationNode.getStart() - right.declarationNode.getStart());
  }

  private functionValueMembers(
    container: Node,
    containerSymbol: ts.Symbol,
  ): readonly JavaScriptAssignmentDeclaration[] {
    const functionValue = JavaScriptExpandoMembers.functionValueOf(container);
    const functionSymbol =
      functionValue && JavaScriptExpandoMembers.declaredSymbolOf(functionValue);
    return [...(functionSymbol?.members ?? new Map<ts.__String, ts.Symbol>())]
      .filter(([name]) => !containerSymbol.members?.has(name))
      .flatMap(([, member]) => this.declaredMembers(member));
  }

  private static declaredSymbolOf(node: Node): ts.Symbol | undefined {
    const symbol = (node.compilerNode as BoundNode).symbol;
    return symbol?.valueDeclaration === node.compilerNode ? symbol : undefined;
  }

  private static functionValueOf(container: Node): Node | undefined {
    const value = Node.isVariableDeclaration(container)
      ? container.getInitializer()
      : JavaScriptExpandoMembers.assignedValueOf(container);
    const unwrapped = value && JavaScriptExpandoMembers.withoutParentheses(value);
    return Node.isFunctionExpression(unwrapped) ? unwrapped : undefined;
  }

  private static assignedValueOf(target: Node): Node | undefined {
    const assignment = target.getParent();
    const assignsTarget =
      Node.isBinaryExpression(assignment) &&
      assignment.getOperatorToken().getKind() === ts.SyntaxKind.EqualsToken &&
      assignment.getLeft() === target;
    return assignsTarget ? assignment.getRight() : undefined;
  }

  private static withoutParentheses(expression: Node): Node {
    return Node.isParenthesizedExpression(expression)
      ? JavaScriptExpandoMembers.withoutParentheses(expression.getExpression())
      : expression;
  }

  private declaredMembers(member: ts.Symbol): readonly JavaScriptAssignmentDeclaration[] {
    const declarations = member.declarations ?? [];
    if (declarations.every(JavaScriptExpandoMembers.isThisDeclaration)) {
      return this.firstThisAssignment(declarations);
    }
    return declarations.flatMap((declaration) => {
      const node = this.wrapped(declaration);
      return node ? JavaScriptExpandoMembers.expandoDeclarationAt(node) : [];
    });
  }

  private firstThisAssignment(
    declarations: readonly ts.Declaration[],
  ): readonly JavaScriptAssignmentDeclaration[] {
    const assignedTargets = declarations
      .filter(ts.isBinaryExpression)
      .map((assignment) => assignment.left)
      .sort((left, right) => left.pos - right.pos);
    for (const assignedTarget of assignedTargets) {
      const node = this.wrapped(assignedTarget);
      const members = node ? JavaScriptExpandoMembers.expandoDeclarationAt(node) : [];
      if (members.length > 0) return members;
    }
    return [];
  }

  private static isThisDeclaration(declaration: ts.Declaration): boolean {
    const declaringAccess = ts.isBinaryExpression(declaration) ? declaration.left : declaration;
    const isAccess =
      ts.isPropertyAccessExpression(declaringAccess) ||
      ts.isElementAccessExpression(declaringAccess);
    return isAccess && declaringAccess.expression.kind === ts.SyntaxKind.ThisKeyword;
  }

  private prototypeObjectMembers(
    prototypeDeclaration: ts.Declaration,
  ): readonly JavaScriptAssignmentDeclaration[] {
    const assignment = this.wrapped(prototypeDeclaration)?.getParent();
    const object = Node.isBinaryExpression(assignment) ? assignment.getRight() : undefined;
    if (!Node.isObjectLiteralExpression(object)) return [];
    return object
      .getProperties()
      .flatMap((property) => JavaScriptExpandoMembers.expandoDeclarationAt(property));
  }

  private static expandoDeclarationAt(node: Node): readonly JavaScriptAssignmentDeclaration[] {
    const declaration = JavaScriptAssignmentDeclarations.declarationAt(node);
    return declaration && declaration.containerNames.length > 0 ? [declaration] : [];
  }

  private wrapped(compilerNode: ts.Node): Node | undefined {
    const start = compilerNode.getStart(this.sourceFile.compilerNode);
    for (
      let node: Node | undefined = this.sourceFile.getDescendantAtPos(start);
      node;
      node = node.getParent()
    ) {
      if (node.compilerNode === compilerNode) return node;
    }
    return undefined;
  }
}
