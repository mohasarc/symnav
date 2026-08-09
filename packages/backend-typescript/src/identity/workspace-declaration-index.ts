import { Project, type Node, type SourceFile } from "ts-morph";
import type { FileSystem, ResolvedPath, SymbolOverviewNode, SymbolIdentity } from "@symnav/core";
import { OverviewTree } from "@symnav/core";

import { extractFileEntries } from "../extract/extract-file-entries.js";
import { WorkspaceFileSystemHost } from "../typescript-backend/workspace-file-system-host.js";
import { DeclarationLocator, type LocatedDeclaration } from "./locate-declarations.js";

export interface IndexedDeclaration {
  readonly declaration: SymbolOverviewNode;
  readonly file: ResolvedPath;
}

export class WorkspaceDeclarationIndex {
  private readonly project: Project;
  private readonly fileByRelativePath = new Map<string, ResolvedPath>();
  private readonly relativePathByAbsolute = new Map<string, string>();
  private readonly declarationsByIdentity = new Map<string, IndexedDeclaration>();
  private readonly declarationsByLocation = new Map<string, Map<number, SymbolOverviewNode>>();
  private readonly declarationsByNode = new WeakMap<Node["compilerNode"], SymbolOverviewNode>();
  private readonly declarationsByFile = new Map<string, readonly SymbolOverviewNode[]>();

  constructor(fs: FileSystem) {
    this.project = new Project({ fileSystem: new WorkspaceFileSystemHost(fs) });
  }

  ensureFiles(files: readonly ResolvedPath[]): void {
    for (const path of files) {
      if (this.fileByRelativePath.has(path.relative)) {
        continue;
      }
      const sourceFile = this.project.addSourceFileAtPath(path.absolute);
      this.fileByRelativePath.set(path.relative, path);
      this.relativePathByAbsolute.set(path.absolute, path.relative);
      this.indexDeclarations(sourceFile, path);
    }
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

  declarationAt(node: Node): SymbolOverviewNode | undefined {
    const relative = this.relativePathOf(node.getSourceFile());
    if (!relative) return undefined;
    return this.declarationsByLocation.get(relative)?.get(node.getStartLineNumber());
  }

  declarationForNode(node: Node): SymbolOverviewNode | undefined {
    return this.declarationsByNode.get(node.compilerNode);
  }

  declarationForIdentity(identity: SymbolIdentity): IndexedDeclaration | undefined {
    return this.declarationsByIdentity.get(DeclarationLocator.identityKey(identity));
  }

  declarationsIn(relativePath: string): readonly SymbolOverviewNode[] | undefined {
    return this.declarationsByFile.get(relativePath);
  }

  relativePathOf(sourceFile: SourceFile): string | undefined {
    return this.relativePathByAbsolute.get(sourceFile.getFilePath());
  }

  private indexDeclarations(sourceFile: SourceFile, path: ResolvedPath): void {
    const byLine = new Map<number, SymbolOverviewNode>();
    const declarations: SymbolOverviewNode[] = [];
    const locator = new DeclarationLocator(sourceFile);
    const { entries } = extractFileEntries({ sourceFile, filePath: path.relative });
    for (const declaration of OverviewTree.walkSymbols(entries)) {
      declarations.push(declaration);
      this.declarationsByIdentity.set(DeclarationLocator.identityKey(declaration.identity), {
        declaration,
        file: path,
      });
      byLine.set(declaration.range.startLine, declaration);
      for (const located of locator.locate(declaration.identity)) {
        this.declarationsByNode.set(located.node.compilerNode, declaration);
      }
    }
    this.declarationsByLocation.set(path.relative, byLine);
    this.declarationsByFile.set(path.relative, declarations);
  }
}
