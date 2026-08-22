import {
  FileNotFoundError,
  OverviewTree,
  type BackendRefreshCoverage,
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
  private readonly revisionsByRelativePath = new Map<string, TypeScriptFileRevision>();
  private readonly fileByRelativePath = new Map<string, ResolvedPath>();
  private readonly relativePathByAbsolute = new Map<string, string>();
  private readonly declarationsByIdentity = new Map<string, IndexedDeclaration>();
  private readonly declarationsByPosition = new Map<string, Map<number, SymbolOverviewNode>>();
  private readonly declarationsByFile = new Map<string, readonly SymbolOverviewNode[]>();

  constructor(private readonly fs: FileSystem) {
    this.project = new Project({ fileSystem: new WorkspaceFileSystemHost(fs) });
  }

  refresh(
    files: readonly WorkspaceFile[],
    coverage: BackendRefreshCoverage = "workspace",
  ): BackendRefreshSummary {
    let added = 0;
    let changed = 0;
    let unchanged = 0;
    for (const file of files) {
      const revision = TypeScriptWorkspaceState.revisionFor(file);
      const current = this.revisionsByRelativePath.get(file.relative);
      if (!current) {
        this.addFile(file);
        added += 1;
        continue;
      }
      if (TypeScriptWorkspaceState.sameRevision(current, revision)) {
        unchanged += 1;
        continue;
      }
      this.changeFile(file, revision);
      changed += 1;
    }
    return { added, changed, removed: 0, unchanged };
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
    const metadata = this.fs.metadataSync(path.absolute);
    const revision: TypeScriptFileRevision = {
      relativePath: path.relative,
      absolutePath: path.absolute,
      size: metadata.size,
      modifiedAtMs: metadata.modifiedAtMs,
    };
    const sourceFile = this.project.addSourceFileAtPath(path.absolute);
    this.publishFile(this.buildFileIndex(sourceFile, path, revision));
  }

  private changeFile(path: ResolvedPath, revision: TypeScriptFileRevision): void {
    const sourceFile = this.project.getSourceFile(path.absolute);
    if (!sourceFile) {
      this.addFile(path);
      return;
    }
    sourceFile.replaceWithText(this.fs.readFileSync(path.absolute));
    this.publishFile(this.buildFileIndex(sourceFile, path, revision));
  }

  private buildFileIndex(
    sourceFile: SourceFile,
    path: ResolvedPath,
    revision: TypeScriptFileRevision,
  ): PreparedFileIndex {
    const byPosition = new Map<number, SymbolOverviewNode>();
    const declarations: SymbolOverviewNode[] = [];
    const byIdentity = new Map<string, IndexedDeclaration>();
    const { entries } = extractFileEntries({ sourceFile, filePath: path.relative });
    for (const declaration of OverviewTree.walkSymbols(entries)) {
      declarations.push(declaration);
      byIdentity.set(DeclarationLocator.identityKey(declaration.identity), {
        declaration,
        file: path,
      });
    }
    for (const { declaration, node } of new DeclarationLocator(sourceFile).locateAll(entries)) {
      byPosition.set(node.getStart(), declaration);
    }
    return {
      revision,
      path,
      declarations,
      declarationsByIdentity: byIdentity,
      declarationsByPosition: byPosition,
    };
  }

  private publishFile(prepared: PreparedFileIndex): void {
    const previousPath = this.fileByRelativePath.get(prepared.path.relative);
    this.purgeIndexes(prepared.path.relative);
    if (previousPath && previousPath.absolute !== prepared.path.absolute) {
      const previousSourceFile = this.project.getSourceFile(previousPath.absolute);
      if (previousSourceFile) {
        this.project.removeSourceFile(previousSourceFile);
      }
      this.relativePathByAbsolute.delete(previousPath.absolute);
    }

    this.revisionsByRelativePath.set(prepared.path.relative, prepared.revision);
    this.fileByRelativePath.set(prepared.path.relative, prepared.path);
    this.relativePathByAbsolute.set(prepared.path.absolute, prepared.path.relative);
    for (const [identity, declaration] of prepared.declarationsByIdentity) {
      this.declarationsByIdentity.set(identity, declaration);
    }
    this.declarationsByPosition.set(
      prepared.path.relative,
      new Map(prepared.declarationsByPosition),
    );
    this.declarationsByFile.set(prepared.path.relative, prepared.declarations);
  }

  private purgeIndexes(relativePath: string): void {
    for (const declaration of this.declarationsByFile.get(relativePath) ?? []) {
      this.declarationsByIdentity.delete(DeclarationLocator.identityKey(declaration.identity));
    }
    this.declarationsByPosition.delete(relativePath);
    this.declarationsByFile.delete(relativePath);
  }

  private static revisionFor(file: WorkspaceFile): TypeScriptFileRevision {
    return {
      relativePath: file.relative,
      absolutePath: file.absolute,
      size: file.metadata.size,
      modifiedAtMs: file.metadata.modifiedAtMs,
    };
  }

  private static sameRevision(
    current: TypeScriptFileRevision,
    incoming: TypeScriptFileRevision,
  ): boolean {
    return (
      current.relativePath === incoming.relativePath &&
      current.absolutePath === incoming.absolutePath &&
      current.size === incoming.size &&
      current.modifiedAtMs === incoming.modifiedAtMs
    );
  }
}
