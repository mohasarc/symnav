import {
  Node,
  Project,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type MethodDeclaration,
  type MethodSignature,
  type ModuleDeclaration,
  type SourceFile,
} from "ts-morph";
import type {
  FileSystem,
  ResolvedPath,
  SymbolDecl,
  SymbolIdentity,
  SymbolPathSegment,
} from "@symnav/core";

import { extractFileSymbols } from "../extract/extract-file-symbols.js";
import { WorkspaceFileSystemHost } from "../typescript-backend/workspace-file-system-host.js";

export interface FindDefinitionsArgs {
  readonly fs: FileSystem;
  readonly files: readonly ResolvedPath[];
  readonly identity: SymbolIdentity;
}

export async function findDefinitions(args: FindDefinitionsArgs): Promise<readonly SymbolDecl[]> {
  const project = new Project({ fileSystem: new WorkspaceFileSystemHost(args.fs) });
  const fileToPath = new Map<string, ResolvedPath>();
  for (const path of args.files) {
    project.addSourceFileAtPath(path.absolute);
    fileToPath.set(path.relative, path);
  }
  const symbolIndex = buildSymbolIndex(project, fileToPath);
  const targetPath = fileToPath.get(args.identity.file);
  if (!targetPath) return [];
  const targetSource = project.getSourceFile(targetPath.absolute);
  if (!targetSource) return [];
  const leafMatches = matchIdentity(targetSource, args.identity, symbolIndex);
  return expandContracts(leafMatches, project, symbolIndex);
}

interface MatchedLeaf {
  readonly decl: SymbolDecl;
  readonly node: Node;
}

type SymbolIndex = ReadonlyMap<string, { readonly decl: SymbolDecl; readonly file: ResolvedPath }>;

function buildSymbolIndex(
  project: Project,
  fileToPath: ReadonlyMap<string, ResolvedPath>,
): SymbolIndex {
  const index = new Map<string, { decl: SymbolDecl; file: ResolvedPath }>();
  for (const [relative, path] of fileToPath) {
    const sourceFile = project.getSourceFile(path.absolute);
    if (!sourceFile) continue;
    const { symbols } = extractFileSymbols({ sourceFile, filePath: relative });
    for (const decl of flatten(symbols)) {
      index.set(identityKey(decl.identity), { decl, file: path });
    }
  }
  return index;
}

function flatten(symbols: readonly SymbolDecl[]): SymbolDecl[] {
  const out: SymbolDecl[] = [];
  for (const symbol of symbols) {
    out.push(symbol);
    out.push(...flatten(symbol.children));
  }
  return out;
}

function identityKey(identity: SymbolIdentity): string {
  return `${identity.file}::${identity.segments.map(segmentKey).join("::")}`;
}

function segmentKey(segment: SymbolPathSegment): string {
  return segment.disambiguator === undefined
    ? segment.name
    : `${segment.name}#${segment.disambiguator}`;
}

function matchIdentity(
  sourceFile: SourceFile,
  identity: SymbolIdentity,
  index: SymbolIndex,
): MatchedLeaf[] {
  const { symbols } = extractFileSymbols({ sourceFile, filePath: identity.file });
  return walkPath(symbols, identity.segments, sourceFile, index);
}

function walkPath(
  candidates: readonly SymbolDecl[],
  remaining: readonly SymbolPathSegment[],
  sourceFile: SourceFile,
  index: SymbolIndex,
): MatchedLeaf[] {
  if (remaining.length === 0) return [];
  const [head, ...rest] = remaining;
  if (!head) return [];
  const matched = candidates.filter((decl) => matchesSegment(decl, head));
  if (rest.length === 0) {
    return matched.flatMap((decl) => {
      const node = locateNodeFor(sourceFile, decl);
      return node ? [{ decl, node }] : [];
    });
  }
  return matched.flatMap((decl) => walkPath(decl.children, rest, sourceFile, index));
}

function matchesSegment(decl: SymbolDecl, segment: SymbolPathSegment): boolean {
  const leaf = decl.identity.segments[decl.identity.segments.length - 1];
  if (!leaf) return false;
  if (leaf.name !== segment.name) return false;
  if (segment.disambiguator === undefined) return true;
  return leaf.disambiguator === segment.disambiguator;
}

function locateNodeFor(sourceFile: SourceFile, decl: SymbolDecl): Node | undefined {
  const startLine = decl.range.startLine;
  let found: Node | undefined;
  sourceFile.forEachDescendant((node) => {
    if (found) return;
    if (!isDefinitionNode(node)) return;
    if (node.getStartLineNumber() !== startLine) return;
    if (declarationName(node) !== ownName(decl)) return;
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

function ownName(decl: SymbolDecl): string {
  const leaf = decl.identity.segments[decl.identity.segments.length - 1];
  return leaf?.name ?? "";
}

function expandContracts(
  matches: readonly MatchedLeaf[],
  project: Project,
  index: SymbolIndex,
): SymbolDecl[] {
  const seen = new Set<string>();
  const out: SymbolDecl[] = [];
  for (const match of matches) {
    addUnique(out, seen, match.decl);
    if (!isContract(match.node)) continue;
    for (const impl of implementationsOf(match.node, project, index)) {
      addUnique(out, seen, impl);
    }
  }
  return out;
}

function addUnique(out: SymbolDecl[], seen: Set<string>, decl: SymbolDecl): void {
  const key = identityKey(decl.identity);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(decl);
}

function isContract(node: Node): boolean {
  if (Node.isMethodSignature(node)) return true;
  if (Node.isMethodDeclaration(node) && node.isAbstract()) return true;
  return false;
}

function implementationsOf(
  node: MethodDeclaration | MethodSignature | Node,
  project: Project,
  index: SymbolIndex,
): SymbolDecl[] {
  if (!Node.isMethodSignature(node) && !Node.isMethodDeclaration(node)) return [];
  const nameNode = node.getNameNode();
  if (!Node.isIdentifier(nameNode)) return [];
  const locations = nameNode.getImplementations();
  const out: SymbolDecl[] = [];
  for (const location of locations) {
    const implNode = location.getNode();
    const owner = enclosingMethod(implNode);
    if (!owner) continue;
    if (owner === node) continue;
    const decl = lookupSymbolDecl(owner, project, index);
    if (decl) out.push(decl);
  }
  return out;
}

function enclosingMethod(node: Node): MethodDeclaration | MethodSignature | undefined {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isMethodDeclaration(current) || Node.isMethodSignature(current)) {
      return current;
    }
    current = current.getParent();
  }
  return undefined;
}

function lookupSymbolDecl(
  node: MethodDeclaration | MethodSignature,
  _project: Project,
  index: SymbolIndex,
): SymbolDecl | undefined {
  const sourceFile = node.getSourceFile();
  const filePath = workspaceRelativeFor(sourceFile, index);
  if (!filePath) return undefined;
  const ancestors = enclosingTypeNames(node);
  const name = node.getName();
  const segments = [...ancestors, name].map((n) => ({ name: n }));
  const key = identityKey({ file: filePath, segments });
  return index.get(key)?.decl;
}

function workspaceRelativeFor(sourceFile: SourceFile, index: SymbolIndex): string | undefined {
  const absolute = sourceFile.getFilePath();
  for (const { file } of index.values()) {
    if (file.absolute === absolute) return file.relative;
  }
  return undefined;
}

function enclosingTypeNames(node: Node): string[] {
  const out: string[] = [];
  let current: Node | undefined = node.getParent();
  while (current) {
    if (isContainer(current)) {
      const name = (
        current as ClassDeclaration | InterfaceDeclaration | ModuleDeclaration
      ).getName();
      if (name) out.unshift(name);
    }
    current = current.getParent();
  }
  return out;
}

function isContainer(
  node: Node,
): node is ClassDeclaration | InterfaceDeclaration | ModuleDeclaration {
  return (
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isModuleDeclaration(node)
  );
}
