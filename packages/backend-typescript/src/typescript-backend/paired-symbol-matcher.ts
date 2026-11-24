import type { SymbolIdentity } from "@symnav/core";
import { Node, type SourceFile, type Symbol, type TypeChecker } from "ts-morph";

import type { DeclarationImplementationFilePair } from "./declaration-implementation-pairs.js";
import type { TypeScriptWorkspaceState } from "./typescript-workspace-state.js";

interface ExportedDeclaration {
  readonly nodes: readonly Node[];
  readonly localName: string;
}

interface PairedSymbolLink {
  readonly declarations: readonly SymbolIdentity[];
  readonly implementations: readonly SymbolIdentity[];
}

export class PairedSymbolMatcher {
  constructor(private readonly workspaceState: TypeScriptWorkspaceState) {}

  counterparts(
    identity: SymbolIdentity,
    pair: DeclarationImplementationFilePair,
  ): readonly SymbolIdentity[] {
    return this.links(pair).flatMap((link) => {
      if (PairedSymbolMatcher.includesSymbol(link.implementations, identity)) {
        return link.declarations;
      }
      if (PairedSymbolMatcher.includesSymbol(link.declarations, identity)) {
        return link.implementations;
      }
      return [];
    });
  }

  private links(pair: DeclarationImplementationFilePair): readonly PairedSymbolLink[] {
    const declarationExports = this.exportedDeclarations(pair.declarationFile);
    const implementationExports = this.exportedDeclarations(pair.implementationFile);
    return [...declarationExports].flatMap(([exportName, declarationExport]) => {
      const implementationExport = implementationExports.get(exportName);
      if (!implementationExport) return [];
      const implementationLocals = implementationExport.nodes.flatMap((node) => {
        const local = this.implementationLocal(node, declarationExport.localName);
        return local ? [local] : [];
      });
      const declarations = this.identitiesOf(declarationExport.nodes);
      const implementations = this.identitiesOf(implementationLocals);
      const linked = declarations.length > 0 && implementations.length > 0;
      return linked ? [{ declarations, implementations }] : [];
    });
  }

  private identitiesOf(nodes: readonly Node[]): readonly SymbolIdentity[] {
    return nodes.flatMap((node) => {
      const identity = this.workspaceState.declarationAt(node)?.identity;
      return identity ? [identity] : [];
    });
  }

  private exportedDeclarations(relativePath: string): ReadonlyMap<string, ExportedDeclaration> {
    const exportedDeclarations = new Map<string, ExportedDeclaration>();
    const sourceFile = this.workspaceState.sourceFile(relativePath);
    const moduleSymbol = sourceFile?.getSymbol();
    if (!sourceFile || !moduleSymbol) return exportedDeclarations;
    const checker = sourceFile.getProject().getTypeChecker();
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const exportedDeclaration = PairedSymbolMatcher.exportedDeclaration(
        exported,
        checker,
        sourceFile,
      );
      if (exportedDeclaration) exportedDeclarations.set(exported.getName(), exportedDeclaration);
    }
    return exportedDeclarations;
  }

  private static exportedDeclaration(
    exported: Symbol,
    checker: TypeChecker,
    sourceFile: SourceFile,
  ): ExportedDeclaration | undefined {
    const local = exported.isAlias() ? checker.getAliasedSymbol(exported) : exported;
    if (!local) return undefined;
    const valueDeclarations = local
      .getDeclarations()
      .filter(
        (declaration) =>
          PairedSymbolMatcher.inFile(declaration, sourceFile) &&
          !PairedSymbolMatcher.declaresTypeOnly(declaration),
      );
    if (valueDeclarations.length === 0) return undefined;
    return { nodes: valueDeclarations, localName: local.getName() };
  }

  private implementationLocal(exportedNode: Node, localName: string): Node | undefined {
    const expression = PairedSymbolMatcher.exportedExpression(exportedNode);
    if (!expression) return exportedNode;
    const checker = exportedNode.getProject().getTypeChecker();
    const identifiers = [expression, ...expression.getDescendants()].filter(
      (node) => Node.isIdentifier(node) && node.getText() === localName,
    );
    for (const identifier of identifiers) {
      const local = this.topLevelDeclarationOf(identifier, checker, exportedNode.getSourceFile());
      if (local) return local;
    }
    return undefined;
  }

  private topLevelDeclarationOf(
    identifier: Node,
    checker: TypeChecker,
    sourceFile: SourceFile,
  ): Node | undefined {
    return checker
      .getSymbolAtLocation(identifier)
      ?.getDeclarations()
      .find(
        (declaration) =>
          PairedSymbolMatcher.inFile(declaration, sourceFile) &&
          this.workspaceState.declarationAt(declaration)?.identity.segments.length === 1,
      );
  }

  private static exportedExpression(exportedNode: Node): Node | undefined {
    if (Node.isExportAssignment(exportedNode)) return exportedNode.getExpression();
    return undefined;
  }

  private static declaresTypeOnly(declaration: Node): boolean {
    if (Node.isInterfaceDeclaration(declaration) || Node.isTypeAliasDeclaration(declaration)) {
      return true;
    }
    if (!Node.isModuleDeclaration(declaration)) return false;
    return declaration
      .getStatements()
      .every((statement) => PairedSymbolMatcher.declaresTypeOnly(statement));
  }

  private static inFile(node: Node, sourceFile: SourceFile): boolean {
    return node.getSourceFile().getFilePath() === sourceFile.getFilePath();
  }

  private static includesSymbol(
    identities: readonly SymbolIdentity[],
    identity: SymbolIdentity,
  ): boolean {
    return identities.some(
      (candidate) =>
        candidate.file === identity.file &&
        candidate.segments.length === identity.segments.length &&
        PairedSymbolMatcher.segmentsMatch(candidate, identity),
    );
  }

  private static segmentsMatch(candidate: SymbolIdentity, identity: SymbolIdentity): boolean {
    return candidate.segments.every((segment, index) => {
      const identitySegment = identity.segments[index]!;
      const isLeaf = index === identity.segments.length - 1;
      const namesCollapsedFamily = isLeaf && identitySegment.disambiguator === undefined;
      const sameDisambiguator = segment.disambiguator === identitySegment.disambiguator;
      return segment.name === identitySegment.name && (namesCollapsedFamily || sameDisambiguator);
    });
  }
}
