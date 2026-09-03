import {
  CollectingDiagnosticSink,
  RevisionedBackendPreparation,
  RevisionedBackendState,
  type DiagnosticSink,
  type FileSystem,
  type IndexedBackendDeclaration,
  type OverviewFileEntries,
  type ResolvedPath,
  type RevisionedBackendPreparationRequest,
  type RevisionedBackendPreparedFile,
  type SymbolIdentity,
  type SymbolOverviewNode,
} from "@symnav/core";
import { Project, type Node, type SourceFile } from "ts-morph";

import { extractFileEntries } from "../extract/extract-file-entries.js";
import { DeclarationLocator, type LocatedDeclaration } from "../identity/locate-declarations.js";
import { WorkspaceFileSystemHost } from "./workspace-file-system-host.js";

export type IndexedDeclaration = IndexedBackendDeclaration;

export interface TypeScriptFileExtractionRequest {
  readonly sourceFile: SourceFile;
  readonly filePath: string;
  readonly diagnostics?: DiagnosticSink;
}

export interface TypeScriptFileExtractor {
  extract(request: TypeScriptFileExtractionRequest): OverviewFileEntries;
}

export interface TypeScriptSemanticSourceProvider {
  sourceFileFor(relativePath: string): SourceFile | undefined;
  sourceFilesFor(relativePath: string): readonly SourceFile[];
}

export class TypeScriptFileEntryExtractor implements TypeScriptFileExtractor {
  extract(request: TypeScriptFileExtractionRequest): OverviewFileEntries {
    return extractFileEntries(request);
  }
}

export interface TypeScriptPreparedFileDetails {
  readonly sourceFile: SourceFile;
  readonly declarationsByPosition: ReadonlyMap<number, SymbolOverviewNode>;
}

interface ProjectMutation {
  rollback(): void;
}

export class TypeScriptWorkspaceState extends RevisionedBackendState<TypeScriptPreparedFileDetails> {
  private readonly project: Project;

  constructor(
    fileSystem: FileSystem,
    private readonly extractor: TypeScriptFileExtractor = new TypeScriptFileEntryExtractor(),
    private readonly semanticSources?: TypeScriptSemanticSourceProvider,
  ) {
    super(fileSystem);
    this.project = new Project({ fileSystem: new WorkspaceFileSystemHost(fileSystem) });
  }

  async fileEntries(
    file: ResolvedPath,
    diagnostics?: DiagnosticSink,
  ): Promise<OverviewFileEntries> {
    const entries = await super.fileEntries(file);
    for (const diagnostic of this.diagnostics(file)) {
      diagnostics?.report(diagnostic);
    }
    return entries;
  }

  sourceFile(relativePath: string): SourceFile | undefined {
    const prepared = this.preparedFile(relativePath);
    if (!prepared) return undefined;
    const semanticSource = this.semanticSources?.sourceFileFor(relativePath);
    if (semanticSource) return semanticSource;
    return prepared.details.sourceFile;
  }

  locate(identity: SymbolIdentity): readonly LocatedDeclaration[] {
    const semanticSource = this.semanticSources?.sourceFileFor(identity.file);
    return this.locateIn(identity, semanticSource ? [semanticSource] : undefined);
  }

  locateSemanticCopies(identity: SymbolIdentity): readonly LocatedDeclaration[] {
    const semanticSources = this.semanticSources?.sourceFilesFor(identity.file);
    return this.locateIn(identity, semanticSources);
  }

  declarationAt(node: Node): SymbolOverviewNode | undefined {
    const relative = this.relativePathOf(node.getSourceFile());
    if (!relative) return undefined;
    return this.preparedFile(relative)?.details.declarationsByPosition.get(node.getStart());
  }

  nodeAt(relativePath: string, start: number): Node | undefined {
    const prepared = this.preparedFile(relativePath);
    if (!prepared) return undefined;
    return prepared.details.sourceFile.getDescendantAtPos(start);
  }

  relativePathOf(sourceFile: SourceFile): string | undefined {
    return this.relativePathForAbsolute(sourceFile.getFilePath());
  }

  protected createPreparation(
    request: RevisionedBackendPreparationRequest<TypeScriptPreparedFileDetails>,
  ): RevisionedBackendPreparation<TypeScriptPreparedFileDetails> {
    return new TypeScriptWorkspacePreparation(this.project, this.extractor, request);
  }

  private locateIn(
    identity: SymbolIdentity,
    semanticSources: readonly SourceFile[] | undefined,
  ): readonly LocatedDeclaration[] {
    const prepared = this.preparedFile(identity.file);
    if (!prepared) return [];
    const sourceFiles =
      semanticSources && semanticSources.length > 0
        ? semanticSources
        : [this.project.getSourceFile(prepared.file.absolute)].filter(
            (sourceFile): sourceFile is SourceFile => sourceFile !== undefined,
          );
    return sourceFiles.flatMap((sourceFile) =>
      new DeclarationLocator(sourceFile).locate(identity, prepared.entries.entries),
    );
  }
}

class TypeScriptWorkspacePreparation extends RevisionedBackendPreparation<TypeScriptPreparedFileDetails> {
  private readonly mutations: ProjectMutation[] = [];
  private rolledBack = false;

  constructor(
    private readonly project: Project,
    private readonly extractor: TypeScriptFileExtractor,
    private readonly request: RevisionedBackendPreparationRequest<TypeScriptPreparedFileDetails>,
  ) {
    super();
  }

  async prepare(): Promise<
    readonly RevisionedBackendPreparedFile<TypeScriptPreparedFileDetails>[]
  > {
    return this.request.changes.map((change) => {
      const previous = change.kind === "changed" ? change.previous : undefined;
      const existingSourceFile =
        previous === undefined || previous.file.absolute === change.file.absolute
          ? this.project.getSourceFile(change.file.absolute)
          : undefined;
      return this.prepareFile(change.file, existingSourceFile, previous !== undefined);
    });
  }

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {
    if (this.rolledBack) return;
    this.rolledBack = true;
    for (const mutation of [...this.mutations].reverse()) {
      mutation.rollback();
    }
  }

  private prepareFile(
    file: RevisionedBackendPreparedFile<TypeScriptPreparedFileDetails>["file"],
    existingSourceFile: SourceFile | undefined,
    readChangedSource: boolean,
  ): RevisionedBackendPreparedFile<TypeScriptPreparedFileDetails> {
    let sourceFile: SourceFile;
    if (existingSourceFile && readChangedSource) {
      const previousText = existingSourceFile.getFullText();
      const content = this.project.getFileSystem().readFileSync(file.absolute);
      existingSourceFile.replaceWithText(content);
      this.mutations.push({ rollback: () => existingSourceFile.replaceWithText(previousText) });
      sourceFile = existingSourceFile;
    } else if (existingSourceFile) {
      sourceFile = existingSourceFile;
    } else {
      sourceFile = this.project.addSourceFileAtPath(file.absolute);
      this.mutations.push({ rollback: () => this.project.removeSourceFile(sourceFile) });
    }
    return this.buildPreparedFile(sourceFile, file);
  }

  private buildPreparedFile(
    sourceFile: SourceFile,
    file: RevisionedBackendPreparedFile<TypeScriptPreparedFileDetails>["file"],
  ): RevisionedBackendPreparedFile<TypeScriptPreparedFileDetails> {
    const declarationsByPosition = new Map<number, SymbolOverviewNode>();
    const diagnosticSink = new CollectingDiagnosticSink();
    const extracted = this.extractor.extract({
      sourceFile,
      filePath: file.relative,
      diagnostics: diagnosticSink,
    });
    const diagnostics = diagnosticSink.diagnostics();
    const entries = diagnostics.length === 0 ? extracted : { ...extracted, diagnostics };
    for (const { declaration, node } of new DeclarationLocator(sourceFile).locateAll(
      entries.entries,
    )) {
      declarationsByPosition.set(node.getStart(), declaration);
    }
    return {
      file,
      entries,
      details: { sourceFile, declarationsByPosition },
    };
  }
}
