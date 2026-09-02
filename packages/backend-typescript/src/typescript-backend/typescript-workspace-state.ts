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

export class TypeScriptFileEntryExtractor implements TypeScriptFileExtractor {
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
  readonly declarations: readonly SymbolOverviewNode[];
  readonly declarationsByPosition: ReadonlyMap<number, SymbolOverviewNode>;
}

interface WorkspacePreparedFileIndex extends PreparedFileIndex {
  readonly byRelativePath: ReadonlyMap<string, PreparedFileState>;
  readonly declarationsByPosition: ReadonlyMap<string, ReadonlyMap<number, SymbolOverviewNode>>;
  readonly relativePathByAbsolute: ReadonlyMap<string, string>;
}

interface ProjectMutation {
  rollback(): void;
}

export class TypeScriptWorkspaceState {
  private readonly project: Project;
  private preparedIndex: WorkspacePreparedFileIndex = {
    byRelativePath: new Map(),
    declarationsByIdentity: new Map(),
    declarationsByPosition: new Map(),
    relativePathByAbsolute: new Map(),
  };

  constructor(
    private readonly fs: FileSystem,
    private readonly extractor: TypeScriptFileExtractor = new TypeScriptFileEntryExtractor(),
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
      const current = this.preparedIndex.byRelativePath.get(revision.relativePath)?.revision;
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
        ? [...this.preparedIndex.byRelativePath.keys()].filter(
            (relativePath) => !incomingPaths.has(relativePath),
          )
        : [];
    const prepared = this.prepareFiles(revisionsToPrepare);
    const nextIndex = this.buildPreparedIndex(prepared, removed);
    this.publishProjectRemovals(prepared, removed);
    this.preparedIndex = nextIndex;

    return {
      added: added.length,
      changed: changed.length,
      removed: removed.length,
      unchanged,
    };
  }

  currentFileCount(): number {
    return this.preparedIndex.byRelativePath.size;
  }

  ensureFiles(files: readonly ResolvedPath[]): void {
    for (const file of files) {
      if (!this.preparedIndex.byRelativePath.has(file.relative)) {
        this.addFile(file);
      }
    }
  }

  fileEntries(file: ResolvedPath, diagnostics?: DiagnosticSink): OverviewFileEntries {
    this.ensureFiles([file]);
    const prepared = this.preparedIndex.byRelativePath.get(file.relative);
    if (!prepared) {
      throw new FileNotFoundError(file.relative);
    }
    for (const diagnostic of prepared.diagnostics) {
      diagnostics?.report(diagnostic);
    }
    return prepared.entries;
  }

  diagnostics(file: ResolvedPath): readonly NavigationDiagnostic[] {
    return this.preparedIndex.byRelativePath.get(file.relative)?.diagnostics ?? [];
  }

  declarationsIn(relativePath: string): readonly SymbolOverviewNode[] | undefined {
    return this.preparedIndex.byRelativePath.get(relativePath)?.declarations;
  }

  allDeclarations(files: readonly ResolvedPath[]): readonly SymbolOverviewNode[] {
    this.ensureFiles(files);
    return files.flatMap((file) => this.declarationsIn(file.relative) ?? []);
  }

  sourceFile(relativePath: string): SourceFile | undefined {
    const prepared = this.preparedIndex.byRelativePath.get(relativePath);
    if (!prepared) return undefined;
    return this.project.getSourceFile(prepared.file.absolute);
  }

  locate(identity: SymbolIdentity): readonly LocatedDeclaration[] {
    const prepared = this.preparedIndex.byRelativePath.get(identity.file);
    if (!prepared) return [];
    const sourceFile = this.project.getSourceFile(prepared.file.absolute);
    if (!sourceFile) return [];
    return new DeclarationLocator(sourceFile).locate(identity, prepared.entries.entries);
  }

  declarationAt(node: Node): SymbolOverviewNode | undefined {
    const relative = this.relativePathOf(node.getSourceFile());
    if (!relative) return undefined;
    return this.preparedIndex.declarationsByPosition.get(relative)?.get(node.getStart());
  }

  declarationForIdentity(identity: SymbolIdentity): IndexedDeclaration | undefined {
    const declaration = this.preparedIndex.declarationsByIdentity.get(
      DeclarationLocator.identityKey(identity),
    )?.[0];
    if (!declaration) return undefined;
    const prepared = this.preparedIndex.byRelativePath.get(declaration.identity.file);
    if (!prepared) return undefined;
    return {
      declaration,
      file: { relative: prepared.file.relative, absolute: prepared.file.absolute },
    };
  }

  relativePathOf(sourceFile: SourceFile): string | undefined {
    return this.preparedIndex.relativePathByAbsolute.get(sourceFile.getFilePath());
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
      this.preparedIndex = this.buildPreparedIndex([preparedFile], []);
    }
  }

  private prepareFiles(revisions: readonly TypeScriptFileRevision[]): readonly PreparedFileState[] {
    const candidates = revisions.map((revision) => {
      const existingPath = this.preparedIndex.byRelativePath.get(revision.relativePath)?.file;
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
    }
    for (const { declaration, node } of new DeclarationLocator(sourceFile).locateAll(
      entries.entries,
    )) {
      byPosition.set(node.getStart(), declaration);
    }
    return {
      revision,
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
      declarationsByPosition: byPosition,
    };
  }

  private buildPreparedIndex(
    preparedFiles: readonly PreparedFileState[],
    removedRelativePaths: readonly string[],
  ): WorkspacePreparedFileIndex {
    if (preparedFiles.length === 0 && removedRelativePaths.length === 0) {
      return this.preparedIndex;
    }
    const byRelativePath = new Map(this.preparedIndex.byRelativePath);
    for (const relativePath of removedRelativePaths) {
      byRelativePath.delete(relativePath);
    }
    for (const prepared of preparedFiles) {
      byRelativePath.set(prepared.file.relative, prepared);
    }

    const declarationsByIdentity = new Map<string, SymbolOverviewNode[]>();
    const declarationsByPosition = new Map<string, ReadonlyMap<number, SymbolOverviewNode>>();
    const relativePathByAbsolute = new Map<string, string>();
    for (const prepared of byRelativePath.values()) {
      for (const declaration of prepared.declarations) {
        const identity = DeclarationLocator.identityKey(declaration.identity);
        const declarations = declarationsByIdentity.get(identity) ?? [];
        declarations.push(declaration);
        declarationsByIdentity.set(identity, declarations);
      }
      declarationsByPosition.set(prepared.file.relative, prepared.declarationsByPosition);
      relativePathByAbsolute.set(prepared.file.absolute, prepared.file.relative);
    }
    return {
      byRelativePath,
      declarationsByIdentity,
      declarationsByPosition,
      relativePathByAbsolute,
    };
  }

  private publishProjectRemovals(
    preparedFiles: readonly PreparedFileState[],
    removedRelativePaths: readonly string[],
  ): void {
    const obsoleteAbsolutePaths = removedRelativePaths.flatMap((relativePath) => {
      const prepared = this.preparedIndex.byRelativePath.get(relativePath);
      return prepared ? [prepared.file.absolute] : [];
    });
    for (const prepared of preparedFiles) {
      const previous = this.preparedIndex.byRelativePath.get(prepared.file.relative);
      if (previous && previous.file.absolute !== prepared.file.absolute) {
        obsoleteAbsolutePaths.push(previous.file.absolute);
      }
    }
    for (const absolutePath of obsoleteAbsolutePaths) {
      const sourceFile = this.project.getSourceFile(absolutePath);
      if (sourceFile) {
        this.project.removeSourceFile(sourceFile);
      }
    }
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
