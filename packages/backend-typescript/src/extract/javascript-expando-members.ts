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
    const symbol = (container.compilerNode as BoundNode).symbol;
    if (!symbol || symbol.valueDeclaration !== container.compilerNode) return [];
    const prototype = symbol.exports?.get(JavaScriptExpandoMembers.PROTOTYPE);
    return [
      ...[...(symbol.members?.values() ?? [])].flatMap((member) => this.declaredMembers(member)),
      ...(prototype?.declarations ?? []).flatMap((declaration) =>
        this.prototypeObjectMembers(declaration),
      ),
    ].sort((left, right) => left.declarationNode.getStart() - right.declarationNode.getStart());
  }

  private declaredMembers(member: ts.Symbol): readonly JavaScriptAssignmentDeclaration[] {
    return (member.declarations ?? []).flatMap((declaration) => {
      const node = this.wrapped(declaration);
      return node ? JavaScriptExpandoMembers.expandoDeclarationAt(node) : [];
    });
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
