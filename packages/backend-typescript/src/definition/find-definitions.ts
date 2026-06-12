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
  return new DefinitionFinder(args).find();
}

interface MatchedDeclaration {
  readonly declaration: SymbolDecl;
  readonly node: Node;
}

interface IndexedDeclaration {
  readonly declaration: SymbolDecl;
  readonly file: ResolvedPath;
}

class DefinitionFinder {
  private readonly project: Project;
  private readonly fileByRelativePath = new Map<string, ResolvedPath>();
  private readonly declarationsByIdentity = new Map<string, IndexedDeclaration>();

  constructor(private readonly args: FindDefinitionsArgs) {
    this.project = new Project({ fileSystem: new WorkspaceFileSystemHost(args.fs) });
  }

  async find(): Promise<readonly SymbolDecl[]> {
    this.loadWorkspaceFiles();
    this.indexAllDeclarations();
    const targetSource = this.targetSourceFile();
    if (!targetSource) return [];
    const matches = this.declarationsMatchingIdentity(targetSource);
    return this.withContractImplementations(matches);
  }

  private loadWorkspaceFiles(): void {
    for (const path of this.args.files) {
      this.project.addSourceFileAtPath(path.absolute);
      this.fileByRelativePath.set(path.relative, path);
    }
  }

  private indexAllDeclarations(): void {
    for (const [relative, path] of this.fileByRelativePath) {
      const sourceFile = this.project.getSourceFile(path.absolute);
      if (!sourceFile) continue;
      const { symbols } = extractFileSymbols({ sourceFile, filePath: relative });
      for (const declaration of withNestedDeclarations(symbols)) {
        this.declarationsByIdentity.set(identityKey(declaration.identity), {
          declaration,
          file: path,
        });
      }
    }
  }

  private targetSourceFile(): SourceFile | undefined {
    const targetPath = this.fileByRelativePath.get(this.args.identity.file);
    if (!targetPath) return undefined;
    return this.project.getSourceFile(targetPath.absolute);
  }

  private declarationsMatchingIdentity(targetSource: SourceFile): MatchedDeclaration[] {
    const { segments } = this.args.identity;
    const ownSegment = segments[segments.length - 1];
    if (!ownSegment) return [];
    let candidates = extractFileSymbols({
      sourceFile: targetSource,
      filePath: this.args.identity.file,
    }).symbols;
    for (const ancestorSegment of segments.slice(0, -1)) {
      candidates = candidates
        .filter((candidate) => ownSegmentMatches(candidate, ancestorSegment))
        .flatMap((candidate) => candidate.children);
    }
    return candidates
      .filter((candidate) => ownSegmentMatches(candidate, ownSegment))
      .flatMap((declaration) => {
        const node = locateDeclarationNode(targetSource, declaration);
        return node ? [{ declaration, node }] : [];
      });
  }

  private withContractImplementations(matches: readonly MatchedDeclaration[]): SymbolDecl[] {
    const seen = new Set<string>();
    const out: SymbolDecl[] = [];
    for (const match of matches) {
      addUniqueDeclaration(out, seen, match.declaration);
      if (!isContract(match.node)) continue;
      for (const implementation of this.implementationsOf(match.node)) {
        addUniqueDeclaration(out, seen, implementation);
      }
    }
    return out;
  }

  private implementationsOf(node: Node): SymbolDecl[] {
    if (!Node.isMethodSignature(node) && !Node.isMethodDeclaration(node)) return [];
    const nameNode = node.getNameNode();
    if (!Node.isIdentifier(nameNode)) return [];
    const out: SymbolDecl[] = [];
    for (const location of nameNode.getImplementations()) {
      const owner = enclosingMethod(location.getNode());
      if (!owner || owner === node) continue;
      const declaration = this.indexedDeclarationFor(owner);
      if (declaration) out.push(declaration);
    }
    return out;
  }

  private indexedDeclarationFor(
    methodNode: MethodDeclaration | MethodSignature,
  ): SymbolDecl | undefined {
    const filePath = this.workspaceRelativePathOf(methodNode.getSourceFile());
    if (!filePath) return undefined;
    const segments = [...enclosingTypeNames(methodNode), methodNode.getName()].map((name) => ({
      name,
    }));
    return this.declarationsByIdentity.get(identityKey({ file: filePath, segments }))?.declaration;
  }

  private workspaceRelativePathOf(sourceFile: SourceFile): string | undefined {
    const absolute = sourceFile.getFilePath();
    for (const file of this.fileByRelativePath.values()) {
      if (file.absolute === absolute) return file.relative;
    }
    return undefined;
  }
}

function withNestedDeclarations(symbols: readonly SymbolDecl[]): readonly SymbolDecl[] {
  const queue = [...symbols];
  for (let i = 0; i < queue.length; i++) {
    queue.push(...queue[i]!.children);
  }
  return queue;
}

function identityKey(identity: SymbolIdentity): string {
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

function addUniqueDeclaration(out: SymbolDecl[], seen: Set<string>, declaration: SymbolDecl): void {
  const key = identityKey(declaration.identity);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(declaration);
}

function isContract(node: Node): boolean {
  if (Node.isMethodSignature(node)) return true;
  if (Node.isMethodDeclaration(node) && node.isAbstract()) return true;
  return false;
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
