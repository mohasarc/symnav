import {
  FileNotFoundError,
  OverviewTree,
  type BackendRefreshSummary,
  type DiagnosticSink,
  type FileSystem,
  type OverviewFileEntries,
  type ResolvedPath,
  type SymbolIdentity,
  type SymbolOverviewNode,
  type WorkspaceFile,
} from "@symnav/core";
import { Project, type Node, type SourceFile } from "ts-morph";

import { extractFileEntries } from "../extract/extract-file-entries.js";
import { DeclarationLocator, type LocatedDeclaration } from "../identity/locate-declarations.js";
import { WorkspaceFileSystemHost } from "./workspace-file-system-host.js";

export interface IndexedDeclaration {
  readonly declaration: SymbolOverviewNode;
  readonly file: ResolvedPath;
}

export interface TypeScriptFileRevision {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly modifiedAtMs: number;
}

interface PreparedFileIndex {
  readonly revision: TypeScriptFileRevision;
  readonly path: ResolvedPath;
  readonly declarations: readonly SymbolOverviewNode[];
  readonly declarationsByIdentity: ReadonlyMap<string, IndexedDeclaration>;
  readonly declarationsByPosition: ReadonlyMap<number, SymbolOverviewNode>;
}

export class TypeScriptWorkspaceState {
  private readonly project: Project;
  private readonly fileByRelativePath = new Map<string, ResolvedPath>();
  private readonly relativePathByAbsolute = new Map<string, string>();
  private readonly declarationsByIdentity = new Map<string, IndexedDeclaration>();
  private readonly declarationsByPosition = new Map<string, Map<number, SymbolOverviewNode>>();
  private readonly declarationsByFile = new Map<string, readonly SymbolOverviewNode[]>();

  constructor(fs: FileSystem) {
    this.project = new Project({ fileSystem: new WorkspaceFileSystemHost(fs) });
  }

  refresh(files: readonly WorkspaceFile[]): BackendRefreshSummary {
    let added = 0;
    let unchanged = 0;
    for (const file of files) {
      if (this.fileByRelativePath.has(file.relative)) {
        unchanged += 1;
        continue;
      }
      this.addFile(file);
      added += 1;
    }
    return { added, changed: 0, removed: 0, unchanged };
  }

  ensureFiles(files: readonly ResolvedPath[]): void {
    for (const file of files) {
      if (!this.fileByRelativePath.has(file.relative)) {
        this.addFile(file);
      }
    }
  }

  fileEntries(file: ResolvedPath, diagnostics?: DiagnosticSink): OverviewFileEntries {
    this.ensureFiles([file]);
    const sourceFile = this.sourceFile(file.relative);
    if (!sourceFile) {
      throw new FileNotFoundError(file.relative);
    }
    return extractFileEntries({ sourceFile, filePath: file.relative, diagnostics });
  }

  declarationsIn(relativePath: string): readonly SymbolOverviewNode[] | undefined {
    return this.declarationsByFile.get(relativePath);
  }

  allDeclarations(files: readonly ResolvedPath[]): readonly SymbolOverviewNode[] {
    this.ensureFiles(files);
    return files.flatMap((file) => this.declarationsIn(file.relative) ?? []);
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
    return this.declarationsByPosition.get(relative)?.get(node.getStart());
  }

  declarationForIdentity(identity: SymbolIdentity): IndexedDeclaration | undefined {
    return this.declarationsByIdentity.get(DeclarationLocator.identityKey(identity));
  }

  relativePathOf(sourceFile: SourceFile): string | undefined {
    return this.relativePathByAbsolute.get(sourceFile.getFilePath());
  }

  private addFile(path: ResolvedPath): void {
    const sourceFile = this.project.addSourceFileAtPath(path.absolute);
    this.fileByRelativePath.set(path.relative, path);
    this.relativePathByAbsolute.set(path.absolute, path.relative);
    this.indexDeclarations(sourceFile, path);
  }

  private indexDeclarations(sourceFile: SourceFile, path: ResolvedPath): void {
    const byPosition = new Map<number, SymbolOverviewNode>();
    const declarations: SymbolOverviewNode[] = [];
    const { entries } = extractFileEntries({ sourceFile, filePath: path.relative });
    for (const declaration of OverviewTree.walkSymbols(entries)) {
      declarations.push(declaration);
      this.declarationsByIdentity.set(DeclarationLocator.identityKey(declaration.identity), {
        declaration,
        file: path,
      });
    }
    for (const { declaration, node } of new DeclarationLocator(sourceFile).locateAll(entries)) {
      byPosition.set(node.getStart(), declaration);
    }
    this.declarationsByPosition.set(path.relative, byPosition);
    this.declarationsByFile.set(path.relative, declarations);
  }
}
