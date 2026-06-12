import { Node, type SourceFile } from "ts-morph";
import type { SymbolDecl, SymbolIdentity, SymbolPathSegment } from "@symnav/core";

import { extractFileSymbols } from "../extract/extract-file-symbols.js";

export interface LocatedDeclaration {
  readonly declaration: SymbolDecl;
  readonly node: Node;
}

export function locateDeclarationsMatchingIdentity(
  sourceFile: SourceFile,
  identity: SymbolIdentity,
): readonly LocatedDeclaration[] {
  const { segments } = identity;
  const ownSegment = segments[segments.length - 1];
  if (!ownSegment) return [];
  let candidates = extractFileSymbols({
    sourceFile,
    filePath: identity.file,
  }).symbols;
  for (const ancestorSegment of segments.slice(0, -1)) {
    candidates = candidates
      .filter((candidate) => ownSegmentMatches(candidate, ancestorSegment))
      .flatMap((candidate) => candidate.children);
  }
  return candidates
    .filter((candidate) => ownSegmentMatches(candidate, ownSegment))
    .flatMap((declaration) => {
      const node = locateDeclarationNode(sourceFile, declaration);
      return node ? [{ declaration, node }] : [];
    });
}

export function identityKey(identity: SymbolIdentity): string {
  return `${identity.file}::${identity.segments.map(segmentKey).join("::")}`;
}

function segmentKey(segment: SymbolPathSegment): string {
  return segment.disambiguator === undefined
    ? segment.name
    : `${segment.name}#${segment.disambiguator}`;
}

function ownSegmentMatches(declaration: SymbolDecl, segment: SymbolPathSegment): boolean {
  const own = declaration.identity.segments[declaration.identity.segments.length - 1];
  if (!own) return false;
  if (own.name !== segment.name) return false;
  if (segment.disambiguator === undefined) return true;
  return own.disambiguator === segment.disambiguator;
}

function locateDeclarationNode(sourceFile: SourceFile, declaration: SymbolDecl): Node | undefined {
  const startLine = declaration.range.startLine;
  let found: Node | undefined;
  sourceFile.forEachDescendant((node) => {
    if (found) return;
    if (!isDefinitionNode(node)) return;
    if (node.getStartLineNumber() !== startLine) return;
    if (declarationName(node) !== ownName(declaration)) return;
    found = node;
  });
  return found;
}

function isDefinitionNode(node: Node): boolean {
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

function declarationName(node: Node): string | undefined {
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
    Node.isSetAccessorDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isPropertySignature(node) ||
    Node.isVariableDeclaration(node)
  ) {
    return node.getName() ?? undefined;
  }
  return undefined;
}

function ownName(declaration: SymbolDecl): string {
  const own = declaration.identity.segments[declaration.identity.segments.length - 1];
  return own?.name ?? "";
}
