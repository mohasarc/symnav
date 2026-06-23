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
  CallTargetResolution,
  FileSystem,
  ResolvedPath,
  SymbolDecl,
  SymbolIdentity,
} from "@symnav/core";

import { extractFileSymbols } from "../extract/extract-file-symbols.js";
import { DeclarationLocator, type LocatedDeclaration } from "../identity/locate-declarations.js";
import { WorkspaceFileSystemHost } from "../typescript-backend/workspace-file-system-host.js";

export interface FindCallTargetArgs {
  readonly fs: FileSystem;
  readonly files: readonly ResolvedPath[];
  readonly identity: SymbolIdentity;
}

export async function findCallTarget(args: FindCallTargetArgs): Promise<CallTargetResolution> {
  return new CallTargetFinder(args).find();
}

class CallTargetFinder {
  private readonly project: Project;
  private readonly fileByRelativePath = new Map<string, ResolvedPath>();
  private readonly declarationsByIdentity = new Map<string, SymbolDecl>();

  constructor(private readonly args: FindCallTargetArgs) {
    this.project = new Project({ fileSystem: new WorkspaceFileSystemHost(args.fs) });
  }

  find(): CallTargetResolution {
    this.loadWorkspaceFiles();
    this.indexAllDeclarations();
    const targetSource = this.targetSourceFile();
    if (!targetSource) return { outcome: "not-found" };
    const matches = new DeclarationLocator(targetSource).locate(this.args.identity);
    if (matches.length === 0) return { outcome: "not-found" };
    const candidates = this.candidatesWithImplementations(matches);
    const implementations = uniqueDeclarations(candidates.filter((c) => carriesBody(c.node)));
    if (implementations.length > 1) {
      return { outcome: "ambiguous", candidates: implementations };
    }
    if (implementations.length === 1) {
      return { outcome: "resolved", target: implementations[0]! };
    }
    return { outcome: "resolved", target: matches[0]!.declaration };
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
        this.declarationsByIdentity.set(
          DeclarationLocator.identityKey(declaration.identity),
          declaration,
        );
      }
    }
  }

  private targetSourceFile(): SourceFile | undefined {
    const targetPath = this.fileByRelativePath.get(this.args.identity.file);
    if (!targetPath) return undefined;
    return this.project.getSourceFile(targetPath.absolute);
  }

  private candidatesWithImplementations(
    matches: readonly LocatedDeclaration[],
  ): LocatedDeclaration[] {
    const out: LocatedDeclaration[] = [];
    for (const match of matches) {
      out.push(match);
      if (isContract(match.node)) {
        out.push(...this.implementationsOf(match.node));
      }
    }
    return out;
  }

  private implementationsOf(node: Node): LocatedDeclaration[] {
    if (!Node.isMethodSignature(node) && !Node.isMethodDeclaration(node)) return [];
    const nameNode = node.getNameNode();
    if (!Node.isIdentifier(nameNode)) return [];
    const out: LocatedDeclaration[] = [];
    for (const location of nameNode.getImplementations()) {
      const owner = enclosingMethod(location.getNode());
      if (!owner || owner === node) continue;
      const declaration = this.indexedDeclarationFor(owner);
      if (declaration) out.push({ declaration, node: owner });
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
    return this.declarationsByIdentity.get(
      DeclarationLocator.identityKey({ file: filePath, segments }),
    );
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

function uniqueDeclarations(located: readonly LocatedDeclaration[]): SymbolDecl[] {
  const seen = new Set<string>();
  const out: SymbolDecl[] = [];
  for (const { declaration } of located) {
    const key = DeclarationLocator.identityKey(declaration.identity);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(declaration);
  }
  return out;
}

function carriesBody(node: Node): boolean {
  return Node.isBodyable(node) && node.hasBody();
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
