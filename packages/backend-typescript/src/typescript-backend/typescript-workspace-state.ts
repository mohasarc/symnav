import {
  CollectingDiagnosticSink,
  FileNotFoundError,
  OverviewTree,
  type BackendRefreshCoverage,
  type BackendRefreshSummary,
  type DiagnosticSink,
  type FileSystem,
  type OverviewFileEntries,
  type NavigationDiagnostic,
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
  readonly changeToken: string;
}

export interface TypeScriptFileExtractionRequest {
  readonly sourceFile: SourceFile;
  readonly filePath: string;
  readonly diagnostics?: DiagnosticSink;
}

export interface TypeScriptFileExtractor {
  extract(request: TypeScriptFileExtractionRequest): OverviewFileEntries;
}

class DefaultTypeScriptFileExtractor implements TypeScriptFileExtractor {
  extract(request: TypeScriptFileExtractionRequest): OverviewFileEntries {
    return extractFileEntries(request);
  }
}

export interface PreparedFileRevision {
  readonly file: WorkspaceFile;
  readonly entries: OverviewFileEntries;
  readonly diagnostics: readonly NavigationDiagnostic[];
}

export interface PreparedFileIndex {
  readonly byRelativePath: ReadonlyMap<string, PreparedFileRevision>;
  readonly declarationsByIdentity: ReadonlyMap<string, readonly SymbolOverviewNode[]>;
}

interface PreparedFileState extends PreparedFileRevision {
  readonly revision: TypeScriptFileRevision;
  readonly path: ResolvedPath;
  readonly declarations: readonly SymbolOverviewNode[];
  readonly declarationsByIdentity: ReadonlyMap<string, IndexedDeclaration>;
  readonly declarationsByPosition: ReadonlyMap<number, SymbolOverviewNode>;
}

interface ProjectMutation {
  rollback(): void;
}

export class TypeScriptWorkspaceState {
  private readonly project: Project;
  private readonly revisionsByRelativePath = new Map<string, TypeScriptFileRevision>();
  private readonly fileByRelativePath = new Map<string, ResolvedPath>();
  private readonly relativePathByAbsolute = new Map<string, string>();
  private readonly declarationsByIdentity = new Map<string, IndexedDeclaration>();
  private readonly declarationsByPosition = new Map<string, Map<number, SymbolOverviewNode>>();
  private readonly declarationsByFile = new Map<string, readonly SymbolOverviewNode[]>();
  private readonly preparedByRelativePath = new Map<string, PreparedFileRevision>();

  constructor(
    private readonly fs: FileSystem,
    private readonly extractor: TypeScriptFileExtractor = new DefaultTypeScriptFileExtractor(),
  ) {
    this.project = new Project({ fileSystem: new WorkspaceFileSystemHost(fs) });
  }

  refresh(
    files: readonly WorkspaceFile[],
    coverage: BackendRefreshCoverage = "workspace",
  ): BackendRefreshSummary {
    const incomingRevisions = files.map((file) => TypeScriptWorkspaceState.revisionFor(file));
    const incomingPaths = new Set(incomingRevisions.map((revision) => revision.relativePath));
    const added: TypeScriptFileRevision[] = [];
    const changed: TypeScriptFileRevision[] = [];
    const revisionsToPrepare: TypeScriptFileRevision[] = [];
    let unchanged = 0;

    for (const revision of incomingRevisions) {
      const current = this.revisionsByRelativePath.get(revision.relativePath);
      if (!current) {
        added.push(revision);
        revisionsToPrepare.push(revision);
        continue;
      }
      if (TypeScriptWorkspaceState.sameRevision(current, revision)) {
        unchanged += 1;
        continue;
      }
      changed.push(revision);
      revisionsToPrepare.push(revision);
    }

    const removed =
      coverage === "workspace"
        ? [...this.revisionsByRelativePath.keys()].filter(
            (relativePath) => !incomingPaths.has(relativePath),
          )
        : [];
    const prepared = this.prepareFiles(revisionsToPrepare);

    for (const relativePath of removed) {
      this.removeFile(relativePath);
    }
    for (const preparedFile of prepared) {
      this.publishFile(preparedFile);
    }

    return {
      added: added.length,
      changed: changed.length,
      removed: removed.length,
      unchanged,
    };
  }

  currentFileCount(): number {
    return this.revisionsByRelativePath.size;
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
    const prepared = this.preparedByRelativePath.get(file.relative);
    if (!prepared) {
      throw new FileNotFoundError(file.relative);
    }
    for (const diagnostic of prepared.diagnostics) {
      diagnostics?.report(diagnostic);
    }
    return prepared.entries;
  }

  diagnostics(file: ResolvedPath): readonly NavigationDiagnostic[] {
    return this.preparedByRelativePath.get(file.relative)?.diagnostics ?? [];
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
    const prepared = this.prepareFiles([
      {
        relativePath: path.relative,
        absolutePath: path.absolute,
        size: metadata.size,
        modifiedAtMs: metadata.modifiedAtMs,
        changeToken: metadata.changeToken,
      },
    ]);
    const preparedFile = prepared[0];
    if (preparedFile) {
      this.publishFile(preparedFile);
    }
  }

  private prepareFiles(revisions: readonly TypeScriptFileRevision[]): readonly PreparedFileState[] {
    const candidates = revisions.map((revision) => {
      const existingPath = this.fileByRelativePath.get(revision.relativePath);
      const existingSourceFile =
        existingPath?.absolute === revision.absolutePath
          ? this.project.getSourceFile(revision.absolutePath)
          : undefined;
      return {
        revision,
        existingSourceFile,
        content: existingSourceFile ? this.fs.readFileSync(revision.absolutePath) : undefined,
      };
    });
    const mutations: ProjectMutation[] = [];

    try {
      return candidates.map(({ revision, existingSourceFile, content }) => {
        const path: ResolvedPath = {
          relative: revision.relativePath,
          absolute: revision.absolutePath,
        };
        let sourceFile: SourceFile;

        if (existingSourceFile) {
          const previousText = existingSourceFile.getFullText();
          existingSourceFile.replaceWithText(content!);
          mutations.push({ rollback: () => existingSourceFile.replaceWithText(previousText) });
          sourceFile = existingSourceFile;
        } else {
          sourceFile = this.project.addSourceFileAtPath(revision.absolutePath);
          mutations.push({ rollback: () => this.project.removeSourceFile(sourceFile) });
        }

        return this.buildFileIndex(sourceFile, path, revision);
      });
    } catch (error) {
      for (const mutation of mutations.reverse()) {
        mutation.rollback();
      }
      throw error;
    }
  }

  private buildFileIndex(
    sourceFile: SourceFile,
    path: ResolvedPath,
    revision: TypeScriptFileRevision,
  ): PreparedFileState {
    const byPosition = new Map<number, SymbolOverviewNode>();
    const declarations: SymbolOverviewNode[] = [];
    const byIdentity = new Map<string, IndexedDeclaration>();
    const diagnosticSink = new CollectingDiagnosticSink();
    const extracted = this.extractor.extract({
      sourceFile,
      filePath: path.relative,
      diagnostics: diagnosticSink,
    });
    const diagnostics = diagnosticSink.diagnostics();
    const entries = diagnostics.length === 0 ? extracted : { ...extracted, diagnostics };
    for (const declaration of OverviewTree.walkSymbols(entries.entries)) {
      declarations.push(declaration);
      byIdentity.set(DeclarationLocator.identityKey(declaration.identity), {
        declaration,
        file: path,
      });
    }
    for (const { declaration, node } of new DeclarationLocator(sourceFile).locateAll(
      entries.entries,
    )) {
      byPosition.set(node.getStart(), declaration);
    }
    return {
      revision,
      path,
      file: {
        ...path,
        metadata: {
          size: revision.size,
          modifiedAtMs: revision.modifiedAtMs,
          changeToken: revision.changeToken,
        },
      },
      entries,
      diagnostics,
      declarations,
      declarationsByIdentity: byIdentity,
      declarationsByPosition: byPosition,
    };
  }

  private publishFile(prepared: PreparedFileState): void {
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
    this.preparedByRelativePath.set(prepared.path.relative, prepared);
    for (const [identity, declaration] of prepared.declarationsByIdentity) {
      this.declarationsByIdentity.set(identity, declaration);
    }
    this.declarationsByPosition.set(
      prepared.path.relative,
      new Map(prepared.declarationsByPosition),
    );
    this.declarationsByFile.set(prepared.path.relative, prepared.declarations);
  }

  private removeFile(relativePath: string): void {
    const path = this.fileByRelativePath.get(relativePath);
    if (path) {
      const sourceFile = this.project.getSourceFile(path.absolute);
      if (sourceFile) {
        this.project.removeSourceFile(sourceFile);
      }
      this.relativePathByAbsolute.delete(path.absolute);
    }
    this.purgeIndexes(relativePath);
    this.fileByRelativePath.delete(relativePath);
    this.revisionsByRelativePath.delete(relativePath);
    this.preparedByRelativePath.delete(relativePath);
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
      changeToken: file.metadata.changeToken,
    };
  }

  private static sameRevision(
    current: TypeScriptFileRevision,
    incoming: TypeScriptFileRevision,
  ): boolean {
    return (
      current.relativePath === incoming.relativePath &&
      current.absolutePath === incoming.absolutePath &&
      current.changeToken === incoming.changeToken
    );
  }
}
