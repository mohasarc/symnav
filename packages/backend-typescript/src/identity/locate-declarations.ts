import { Node, type SourceFile } from "ts-morph";
import {
  OverviewTree,
  type OverviewNode,
  type SymbolOverviewNode,
  type SymbolIdentity,
  type SymbolPathSegment,
} from "@symnav/core";

import { extractFileEntries } from "../extract/extract-file-entries.js";

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

  locate(identity: SymbolIdentity): readonly LocatedDeclaration[] {
    const { segments } = identity;
    const ownSegment = segments[segments.length - 1];
    if (!ownSegment) return [];
    let candidates = OverviewTree.scopeSymbols(
      extractFileEntries({
        sourceFile: this.sourceFile,
        filePath: identity.file,
      }).entries,
    );
    for (const ancestorSegment of segments.slice(0, -1)) {
      candidates = candidates
        .filter((candidate) => this.ownSegmentMatches(candidate, ancestorSegment))
        .flatMap((candidate) => OverviewTree.scopeSymbols(candidate.children));
    }
    return candidates
      .filter((candidate) => this.ownSegmentMatches(candidate, ownSegment))
      .flatMap((declaration) => {
        const node = this.locateDeclarationNode(declaration);
        return node ? [{ declaration, node }] : [];
      });
  }

  locateAll(entries: readonly OverviewNode[]): readonly LocatedDeclaration[] {
    const declarationsByLineAndName = this.declarationsByLineAndName(entries);
    const locatedDeclarations: LocatedDeclaration[] = [];
    this.sourceFile.forEachDescendant((node) => {
      if (!this.isDefinitionNode(node)) return;
      const name = this.declarationName(node);
      if (!name) return;
      const location = DeclarationLocator.locationKey(node.getStartLineNumber(), name);
      const declarations = declarationsByLineAndName.get(location);
      const declaration = declarations?.shift();
      if (declaration) locatedDeclarations.push({ declaration, node });
    });
    return locatedDeclarations;
  }

  private declarationsByLineAndName(
    entries: readonly OverviewNode[],
  ): Map<string, SymbolOverviewNode[]> {
    const declarationsByLineAndName = new Map<string, SymbolOverviewNode[]>();
    for (const declaration of OverviewTree.walkSymbols(entries)) {
      const location = DeclarationLocator.locationKey(
        declaration.range.startLine,
        OverviewTree.ownName(declaration),
      );
      const declarations = declarationsByLineAndName.get(location) ?? [];
      declarations.push(declaration);
      declarationsByLineAndName.set(location, declarations);
    }
    return declarationsByLineAndName;
  }

  private static locationKey(line: number, name: string): string {
    return `${line}:${name}`;
  }

  private ownSegmentMatches(declaration: SymbolOverviewNode, segment: SymbolPathSegment): boolean {
    const own = declaration.identity.segments[declaration.identity.segments.length - 1];
    if (!own) return false;
    if (own.name !== segment.name) return false;
    if (segment.disambiguator === undefined) return true;
    return own.disambiguator === segment.disambiguator;
  }

  private locateDeclarationNode(declaration: SymbolOverviewNode): Node | undefined {
    const startLine = declaration.range.startLine;
    let found: Node | undefined;
    this.sourceFile.forEachDescendant((node) => {
      if (found) return;
      if (!this.isDefinitionNode(node)) return;
      if (node.getStartLineNumber() !== startLine) return;
      if (this.declarationName(node) !== OverviewTree.ownName(declaration)) return;
      found = node;
    });
    return found;
  }

  private isDefinitionNode(node: Node): boolean {
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

  private declarationName(node: Node): string | undefined {
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
