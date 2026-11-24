import { ts, type Node, type SourceFile } from "ts-morph";

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
    return [...(symbol.members?.values() ?? [])]
      .flatMap((member) => member.declarations ?? [])
      .flatMap((declaration) => {
        const node = this.wrapped(declaration);
        const member = node && JavaScriptAssignmentDeclarations.declarationAt(node);
        return member && member.containerNames.length > 0 ? [member] : [];
      })
      .sort((left, right) => left.declarationNode.getStart() - right.declarationNode.getStart());
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
