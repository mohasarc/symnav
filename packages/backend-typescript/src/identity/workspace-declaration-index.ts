import { Project, type Node, type SourceFile } from "ts-morph";
import type { FileSystem, ResolvedPath, SymbolDecl, SymbolIdentity } from "@symnav/core";

import { extractFileSymbols } from "../extract/extract-file-symbols.js";
import { WorkspaceFileSystemHost } from "../typescript-backend/workspace-file-system-host.js";
import { DeclarationLocator, type LocatedDeclaration } from "./locate-declarations.js";

export interface WorkspaceDeclarationIndexArgs {
  readonly fs: FileSystem;
  readonly files: readonly ResolvedPath[];
}

export interface IndexedDeclaration {
  readonly declaration: SymbolDecl;
  readonly file: ResolvedPath;
}

export class WorkspaceDeclarationIndex {
  private readonly project: Project;
  private readonly fileByRelativePath = new Map<string, ResolvedPath>();
  private readonly relativePathByAbsolute = new Map<string, string>();
  private readonly declarationsByIdentity = new Map<string, IndexedDeclaration>();
  private readonly declarationsByLocation = new Map<string, Map<number, SymbolDecl>>();

  constructor(private readonly args: WorkspaceDeclarationIndexArgs) {
    this.project = new Project({ fileSystem: new WorkspaceFileSystemHost(args.fs) });
    this.loadWorkspaceFiles();
    this.indexAllDeclarations();
  }

  sourceFile(relativePath: string): SourceFile | undefined {
    const path = this.fileByRelativePath.get(relativePath);
    if (!path) return undefined;
    return this.project.getSourceFile(path.absolute);
  }

  locate(identity: SymbolIdentity): readonly LocatedDeclaration[] {
    const sourceFile = this.sourceFile(identity.file);
    if (!sourceFile) return [];
    return new DeclarationLocator(sourceFile).locate(identity);
  }

  declarationAt(node: Node): SymbolDecl | undefined {
    const relative = this.relativePathOf(node.getSourceFile());
    if (!relative) return undefined;
    return this.declarationsByLocation.get(relative)?.get(node.getStartLineNumber());
  }

  declarationForIdentity(identity: SymbolIdentity): IndexedDeclaration | undefined {
    return this.declarationsByIdentity.get(DeclarationLocator.identityKey(identity));
  }

  relativePathOf(sourceFile: SourceFile): string | undefined {
    return this.relativePathByAbsolute.get(sourceFile.getFilePath());
  }

  private loadWorkspaceFiles(): void {
    for (const path of this.args.files) {
      this.project.addSourceFileAtPath(path.absolute);
      this.fileByRelativePath.set(path.relative, path);
      this.relativePathByAbsolute.set(path.absolute, path.relative);
    }
  }

  private indexAllDeclarations(): void {
    for (const [relative, path] of this.fileByRelativePath) {
      const sourceFile = this.project.getSourceFile(path.absolute);
      if (!sourceFile) continue;
      const byLine = new Map<number, SymbolDecl>();
      const { symbols } = extractFileSymbols({ sourceFile, filePath: relative });
      for (const declaration of withNestedDeclarations(symbols)) {
        this.declarationsByIdentity.set(DeclarationLocator.identityKey(declaration.identity), {
          declaration,
          file: path,
        });
        byLine.set(declaration.range.startLine, declaration);
      }
      this.declarationsByLocation.set(relative, byLine);
    }
  }
}

function withNestedDeclarations(symbols: readonly SymbolDecl[]): readonly SymbolDecl[] {
  const queue = [...symbols];
  for (let i = 0; i < queue.length; i++) {
    queue.push(...queue[i]!.children);
  }
  return queue;
}
