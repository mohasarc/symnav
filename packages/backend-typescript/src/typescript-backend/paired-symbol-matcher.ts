import type { SymbolIdentity } from "@symnav/core";
import { Node, ts, type SourceFile, type Symbol, type TypeChecker } from "ts-morph";

import type { DeclarationImplementationFilePair } from "./declaration-implementation-pairs.js";
import type { TypeScriptWorkspaceState } from "./typescript-workspace-state.js";

interface ExportedDeclaration {
  readonly nodes: readonly Node[];
  readonly localName: string;
}

interface LinkedCounterparts {
  readonly counterparts: readonly SymbolIdentity[];
  readonly memberNames: readonly string[];
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
      const linked = PairedSymbolMatcher.linkedCounterparts(link, identity);
      if (!linked) return [];
      if (linked.memberNames.length === 0) return linked.counterparts;
      const targetStaticness = this.staticnessOf(identity);
      return linked.counterparts.flatMap((counterpart) =>
        this.membersNamed(counterpart, linked.memberNames).filter((member) =>
          PairedSymbolMatcher.staticnessOverlaps(targetStaticness, this.staticnessOf(member)),
        ),
      );
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
    const exportEquals = moduleSymbol.getExport(ts.InternalSymbolName.ExportEquals);
    const exportedSymbols: readonly (readonly [string, Symbol])[] = [
      ...(exportEquals ? [[ts.InternalSymbolName.Default, exportEquals] as const] : []),
      ...checker
        .getExportsOfModule(moduleSymbol)
        .map((exported) => [exported.getName(), exported] as const),
    ];
    for (const [exportName, exported] of exportedSymbols) {
      const exportedDeclaration = PairedSymbolMatcher.exportedDeclaration(
        exported,
        checker,
        sourceFile,
      );
      if (exportedDeclaration) exportedDeclarations.set(exportName, exportedDeclaration);
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
    return Node.isBinaryExpression(exportedNode) ? exportedNode.getLeft() : undefined;
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

  private membersNamed(
    owner: SymbolIdentity,
    memberNames: readonly string[],
  ): readonly SymbolIdentity[] {
    return (this.workspaceState.declarationsIn(owner.file) ?? []).flatMap(({ identity }) => {
      const memberSegments = identity.segments.slice(owner.segments.length);
      const sameMemberNames =
        memberSegments.length === memberNames.length &&
        memberSegments.every((segment, index) => segment.name === memberNames[index]);
      return PairedSymbolMatcher.isPrefix(owner, identity) && sameMemberNames ? [identity] : [];
    });
  }

  private staticnessOf(identity: SymbolIdentity): ReadonlySet<boolean> {
    return new Set(
      this.workspaceState
        .locate(identity)
        .flatMap(({ node }) => PairedSymbolMatcher.memberStaticness(node)),
    );
  }

  private static memberStaticness(node: Node): readonly boolean[] {
    if (Node.isStaticable(node)) return [node.isStatic()];
    const statement = Node.isVariableDeclaration(node) ? node.getVariableStatement() : node;
    const isNamespaceMember = Node.isModuleBlock(statement?.getParent());
    return isNamespaceMember ? [true] : [];
  }

  private static staticnessOverlaps(
    targetStaticness: ReadonlySet<boolean>,
    memberStaticness: ReadonlySet<boolean>,
  ): boolean {
    const eitherStaticnessIsUnknown = targetStaticness.size === 0 || memberStaticness.size === 0;
    if (eitherStaticnessIsUnknown) return true;
    return [...memberStaticness].some((isStatic) => targetStaticness.has(isStatic));
  }

  private static exportedExpression(exportedNode: Node): Node | undefined {
    if (Node.isExportAssignment(exportedNode)) return exportedNode.getExpression();
    if (Node.isBinaryExpression(exportedNode)) return exportedNode.getRight();
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

  private static linkedCounterparts(
    link: PairedSymbolLink,
    identity: SymbolIdentity,
  ): LinkedCounterparts | undefined {
    const sides = [
      [link.implementations, link.declarations],
      [link.declarations, link.implementations],
    ] as const;
    for (const [linkedSide, counterparts] of sides) {
      const owner = linkedSide.find((linked) => PairedSymbolMatcher.isPrefix(linked, identity));
      if (!owner) continue;
      const memberNames = identity.segments
        .slice(owner.segments.length)
        .map((segment) => segment.name);
      return { counterparts, memberNames };
    }
    return undefined;
  }

  private static isPrefix(prefix: SymbolIdentity, identity: SymbolIdentity): boolean {
    if (prefix.file !== identity.file) return false;
    if (prefix.segments.length > identity.segments.length) return false;
    return PairedSymbolMatcher.segmentsMatch(prefix, identity);
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
