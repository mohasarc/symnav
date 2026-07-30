import { Node, type SourceFile } from "ts-morph";
import type {
  OverviewNode,
  SymbolOverviewNode,
  SymbolIdentity,
  SymbolPathSegment,
} from "@symnav/core";

import { extractFileSymbols } from "../extract/extract-file-symbols.js";

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
    let candidates = extractFileSymbols({
      sourceFile: this.sourceFile,
      filePath: identity.file,
    }).entries.flatMap((entry) => symbolScopeChildren(entry));
    for (const ancestorSegment of segments.slice(0, -1)) {
      candidates = candidates
        .filter((candidate) => this.ownSegmentMatches(candidate, ancestorSegment))
        .flatMap((candidate) => candidate.children.flatMap((child) => symbolScopeChildren(child)));
    }
    return candidates
      .filter((candidate) => this.ownSegmentMatches(candidate, ownSegment))
      .flatMap((declaration) => {
        const node = this.locateDeclarationNode(declaration);
        return node ? [{ declaration, node }] : [];
      });
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
      if (this.declarationName(node) !== this.ownName(declaration)) return;
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
      Node.isVariableDeclaration(node)
    );
  }

  private declarationName(node: Node): string | undefined {
    if (Node.isConstructorDeclaration(node)) return "constructor";
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
      Node.isPropertyDeclaration(node) ||
      Node.isPropertySignature(node) ||
      Node.isVariableDeclaration(node)
    ) {
      return node.getName() ?? undefined;
    }
    return undefined;
  }

  private ownName(declaration: SymbolOverviewNode): string {
    const own = declaration.identity.segments[declaration.identity.segments.length - 1];
    return own?.name ?? "";
  }
}

function symbolScopeChildren(node: OverviewNode): readonly SymbolOverviewNode[] {
  if (node.type === "symbol") return [node];
  return node.children.flatMap((child) => symbolScopeChildren(child));
}
