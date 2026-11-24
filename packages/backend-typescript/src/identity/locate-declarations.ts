import { Node, type SourceFile, type SyntaxKind } from "ts-morph";
import {
  OverviewTree,
  type OverviewNode,
  type SymbolOverviewNode,
  type SymbolIdentity,
  type SymbolPathSegment,
} from "@symnav/core";

import { JavaScriptAssignmentDeclarations } from "../extract/javascript-assignment-declaration.js";
import { JavaScriptDocDeclarations } from "../extract/javascript-doc-declarations.js";

export interface DeclarationSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: SyntaxKind;
}

export interface LocatedDeclaration {
  readonly declaration: SymbolOverviewNode;
  readonly node: Node;
}

export class DeclarationLocator {
  static identityKey(identity: SymbolIdentity): string {
    return `${identity.file}::${identity.segments.map(DeclarationLocator.segmentKey).join("::")}`;
  }

  private static segmentKey(segment: SymbolPathSegment): string {
    return segment.disambiguator === undefined
      ? segment.name
      : `${segment.name}#${segment.disambiguator}`;
  }

  constructor(private readonly sourceFile: SourceFile) {}

  static spanOf(declaration: SymbolOverviewNode, node: Node): DeclarationSpan | undefined {
    const locatable = DeclarationLocator.definitionName(node) === OverviewTree.ownName(declaration);
    if (!locatable) return undefined;
    return { start: node.getStart(), end: node.getEnd(), kind: node.getKind() };
  }

  locate(
    identity: SymbolIdentity,
    preparedEntries: readonly OverviewNode[],
    declarationSpans: ReadonlyMap<SymbolOverviewNode, DeclarationSpan>,
  ): readonly LocatedDeclaration[] {
    const { segments } = identity;
    const ownSegment = segments[segments.length - 1];
    if (!ownSegment) return [];
    let candidates = OverviewTree.scopeSymbols(preparedEntries);
    for (const ancestorSegment of segments.slice(0, -1)) {
      candidates = candidates
        .filter((candidate) => DeclarationLocator.ownSegmentMatches(candidate, ancestorSegment))
        .flatMap((candidate) => OverviewTree.scopeSymbols(candidate.children));
    }
    return candidates
      .filter((candidate) => DeclarationLocator.ownSegmentMatches(candidate, ownSegment))
      .flatMap((declaration) => {
        const span = declarationSpans.get(declaration);
        const node = span && this.nodeSpanning(span);
        return node ? [{ declaration, node }] : [];
      });
  }

  private nodeSpanning(span: DeclarationSpan): Node | undefined {
    for (
      let node: Node | undefined = this.sourceFile.getDescendantAtPos(span.start);
      node && node.getStart() === span.start;
      node = node.getParent()
    ) {
      const spansDeclaration = node.getEnd() === span.end && node.getKind() === span.kind;
      if (spansDeclaration) return node;
    }
    return undefined;
  }

  private static ownSegmentMatches(
    declaration: SymbolOverviewNode,
    segment: SymbolPathSegment,
  ): boolean {
    const own = declaration.identity.segments[declaration.identity.segments.length - 1];
    if (!own) return false;
    if (own.name !== segment.name) return false;
    if (segment.disambiguator === undefined) return true;
    return own.disambiguator === segment.disambiguator;
  }

  private static definitionName(node: Node): string | undefined {
    const assignment = JavaScriptAssignmentDeclarations.declarationAt(node);
    if (assignment) return assignment.name;
    const typeAlias = JavaScriptDocDeclarations.typeAliasNamedBy(node);
    if (typeAlias) return typeAlias.name;
    return DeclarationLocator.isDefinitionNode(node)
      ? DeclarationLocator.declarationName(node)
      : undefined;
  }

  private static isDefinitionNode(node: Node): boolean {
    return (
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isMethodSignature(node) ||
      Node.isConstructorDeclaration(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node) ||
      Node.isClassDeclaration(node) ||
      Node.isInterfaceDeclaration(node) ||
      Node.isTypeAliasDeclaration(node) ||
      Node.isEnumDeclaration(node) ||
      Node.isModuleDeclaration(node) ||
      Node.isPropertyDeclaration(node) ||
      Node.isPropertySignature(node) ||
      Node.isVariableDeclaration(node) ||
      Node.isExportAssignment(node)
    );
  }

  private static declarationName(node: Node): string | undefined {
    if (Node.isConstructorDeclaration(node)) return "constructor";
    if (Node.isExportAssignment(node)) return "default";
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isClassDeclaration(node) ||
      Node.isInterfaceDeclaration(node) ||
      Node.isTypeAliasDeclaration(node) ||
      Node.isEnumDeclaration(node) ||
      Node.isModuleDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isMethodSignature(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node) ||
      Node.isPropertyDeclaration(node) ||
      Node.isPropertySignature(node) ||
      Node.isVariableDeclaration(node)
    ) {
      return node.getName() ?? undefined;
    }
    return undefined;
  }
}
