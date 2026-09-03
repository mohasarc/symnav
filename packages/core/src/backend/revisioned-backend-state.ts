import type { NavigationDiagnostic } from "../diagnostics/navigation-diagnostic.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import type {
  OverviewFileEntries,
  SymbolOverviewNode,
} from "../intermediate-representation/overview-tree.js";
import { OverviewTree } from "../intermediate-representation/overview-tree.js";
import { FileNotFoundError } from "../workspace/errors.js";
import type { FileSystem } from "../workspace/file-system.js";
import type { ResolvedPath, WorkspaceFile } from "../workspace/workspace.js";
import type { BackendRefreshCoverage, BackendRefreshSummary } from "./language-backend.js";

export interface RevisionedBackendPreparedFile<PreparedDetails> {
  readonly file: WorkspaceFile;
  readonly entries: OverviewFileEntries;
  readonly details: PreparedDetails;
}

export type RevisionedBackendFileChange<PreparedDetails> =
  | { readonly kind: "added"; readonly file: WorkspaceFile }
  | {
      readonly kind: "changed";
      readonly file: WorkspaceFile;
      readonly previous: RevisionedBackendPreparedFile<PreparedDetails>;
    };

export interface RevisionedBackendPreparationRequest<PreparedDetails> {
  readonly coverage: BackendRefreshCoverage;
  readonly changes: readonly RevisionedBackendFileChange<PreparedDetails>[];
  readonly removedFiles: readonly RevisionedBackendPreparedFile<PreparedDetails>[];
  readonly effectiveFiles: readonly WorkspaceFile[];
}

export abstract class RevisionedBackendPreparation<PreparedDetails> {
  abstract prepare(): Promise<readonly RevisionedBackendPreparedFile<PreparedDetails>[]>;
  abstract commit(): Promise<void>;
  abstract rollback(): Promise<void>;
}

export interface IndexedBackendDeclaration {
  readonly declaration: SymbolOverviewNode;
  readonly file: ResolvedPath;
}

interface RevisionedBackendIndex<PreparedDetails> {
  readonly byRelativePath: ReadonlyMap<string, RevisionedBackendPreparedFile<PreparedDetails>>;
  readonly declarationsByIdentity: ReadonlyMap<string, readonly SymbolOverviewNode[]>;
  readonly declarationsByRelativePath: ReadonlyMap<string, readonly SymbolOverviewNode[]>;
  readonly diagnosticsByRelativePath: ReadonlyMap<string, readonly NavigationDiagnostic[]>;
  readonly relativePathByAbsolute: ReadonlyMap<string, string>;
}

export abstract class RevisionedBackendState<PreparedDetails> {
  private index: RevisionedBackendIndex<PreparedDetails> = {
    byRelativePath: new Map(),
    declarationsByIdentity: new Map(),
    declarationsByRelativePath: new Map(),
    diagnosticsByRelativePath: new Map(),
    relativePathByAbsolute: new Map(),
  };

  protected constructor(private readonly fileSystem: FileSystem) {}

  async refresh(
    files: readonly WorkspaceFile[],
    coverage: BackendRefreshCoverage = "workspace",
  ): Promise<BackendRefreshSummary> {
    const request = this.preparationRequest(files, coverage);
    const preparation = this.createPreparation(request);
    const preparedFiles = await preparation.prepare();
    const candidate = this.candidateIndex(request, preparedFiles);
    await preparation.commit();
    this.index = candidate;
    return this.refreshSummary(request, files);
  }

  async ensureFiles(files: readonly ResolvedPath[]): Promise<void> {
    const missingFiles = files.filter((file) => !this.index.byRelativePath.has(file.relative));
    if (missingFiles.length === 0) return;
    const workspaceFiles = await Promise.all(
      missingFiles.map(async (file) => ({
        ...file,
        metadata: await this.fileSystem.metadata(file.absolute),
      })),
    );
    await this.refresh(workspaceFiles, "selection");
  }

  async fileEntries(file: ResolvedPath): Promise<OverviewFileEntries> {
    await this.ensureFiles([file]);
    const prepared = this.index.byRelativePath.get(file.relative);
    if (!prepared) throw new FileNotFoundError(file.relative);
    return prepared.entries;
  }

  async declarations(files: readonly ResolvedPath[]): Promise<readonly SymbolOverviewNode[]> {
    await this.ensureFiles(files);
    return files.flatMap((file) => this.index.declarationsByRelativePath.get(file.relative) ?? []);
  }

  diagnostics(file: ResolvedPath): readonly NavigationDiagnostic[] {
    return this.index.diagnosticsByRelativePath.get(file.relative) ?? [];
  }

  declarationsIn(relativePath: string): readonly SymbolOverviewNode[] | undefined {
    return this.index.declarationsByRelativePath.get(relativePath);
  }

  declarationForIdentity(identity: SymbolIdentity): IndexedBackendDeclaration | undefined {
    const declaration = this.index.declarationsByIdentity.get(formatSymbolIdentity(identity))?.[0];
    if (!declaration) return undefined;
    const prepared = this.index.byRelativePath.get(declaration.identity.file);
    if (!prepared) return undefined;
    return {
      declaration,
      file: { relative: prepared.file.relative, absolute: prepared.file.absolute },
    };
  }

  currentFileCount(): number {
    return this.index.byRelativePath.size;
  }

  protected preparedFile(
    relativePath: string,
  ): RevisionedBackendPreparedFile<PreparedDetails> | undefined {
    return this.index.byRelativePath.get(relativePath);
  }

  protected preparedFiles(): readonly RevisionedBackendPreparedFile<PreparedDetails>[] {
    return [...this.index.byRelativePath.values()];
  }

  protected relativePathForAbsolute(absolutePath: string): string | undefined {
    return this.index.relativePathByAbsolute.get(absolutePath);
  }

  protected abstract createPreparation(
    request: RevisionedBackendPreparationRequest<PreparedDetails>,
  ): RevisionedBackendPreparation<PreparedDetails>;

  private preparationRequest(
    files: readonly WorkspaceFile[],
    coverage: BackendRefreshCoverage,
  ): RevisionedBackendPreparationRequest<PreparedDetails> {
    const incomingByRelativePath = new Map(files.map((file) => [file.relative, file]));
    const changes = files.flatMap((file): RevisionedBackendFileChange<PreparedDetails>[] => {
      const previous = this.index.byRelativePath.get(file.relative);
      if (!previous) return [{ kind: "added", file }];
      if (RevisionedBackendState.sameRevision(previous.file, file)) return [];
      return [{ kind: "changed", file, previous }];
    });
    const removedFiles =
      coverage === "workspace"
        ? [...this.index.byRelativePath.values()].filter(
            (prepared) => !incomingByRelativePath.has(prepared.file.relative),
          )
        : [];
    const effectiveByRelativePath =
      coverage === "workspace"
        ? new Map<string, WorkspaceFile>()
        : new Map(
            [...this.index.byRelativePath.values()].map((prepared) => [
              prepared.file.relative,
              prepared.file,
            ]),
          );
    for (const file of files) {
      effectiveByRelativePath.set(file.relative, file);
    }
    return {
      coverage,
      changes,
      removedFiles,
      effectiveFiles: [...effectiveByRelativePath.values()],
    };
  }

  private candidateIndex(
    request: RevisionedBackendPreparationRequest<PreparedDetails>,
    preparedFiles: readonly RevisionedBackendPreparedFile<PreparedDetails>[],
  ): RevisionedBackendIndex<PreparedDetails> {
    const preparedByRelativePath = new Map(
      preparedFiles.map((prepared) => [prepared.file.relative, prepared]),
    );
    const candidateByRelativePath = new Map(this.index.byRelativePath);
    for (const removed of request.removedFiles) {
      candidateByRelativePath.delete(removed.file.relative);
    }
    for (const change of request.changes) {
      const prepared = preparedByRelativePath.get(change.file.relative);
      if (prepared) candidateByRelativePath.set(change.file.relative, prepared);
    }
    return RevisionedBackendState.buildIndex(candidateByRelativePath, this.index);
  }

  private refreshSummary(
    request: RevisionedBackendPreparationRequest<PreparedDetails>,
    files: readonly WorkspaceFile[],
  ): BackendRefreshSummary {
    const added = request.changes.filter((change) => change.kind === "added").length;
    return {
      added,
      changed: request.changes.length - added,
      removed: request.removedFiles.length,
      unchanged: files.length - request.changes.length,
    };
  }

  private static buildIndex<PreparedDetails>(
    byRelativePath: ReadonlyMap<string, RevisionedBackendPreparedFile<PreparedDetails>>,
    previous: RevisionedBackendIndex<PreparedDetails>,
  ): RevisionedBackendIndex<PreparedDetails> {
    const declarationsByIdentity = new Map<string, SymbolOverviewNode[]>();
    const declarationsByRelativePath = new Map<string, readonly SymbolOverviewNode[]>();
    const diagnosticsByRelativePath = new Map<string, readonly NavigationDiagnostic[]>();
    const relativePathByAbsolute = new Map<string, string>();
    for (const prepared of byRelativePath.values()) {
      const previousPrepared = previous.byRelativePath.get(prepared.file.relative);
      const unchanged = previousPrepared === prepared;
      const declarations = unchanged
        ? (previous.declarationsByRelativePath.get(prepared.file.relative) ?? [])
        : OverviewTree.walkSymbols(prepared.entries.entries);
      declarationsByRelativePath.set(prepared.file.relative, declarations);
      diagnosticsByRelativePath.set(
        prepared.file.relative,
        unchanged
          ? (previous.diagnosticsByRelativePath.get(prepared.file.relative) ?? [])
          : (prepared.entries.diagnostics ?? []),
      );
      relativePathByAbsolute.set(prepared.file.absolute, prepared.file.relative);
      for (const declaration of declarations) {
        const key = formatSymbolIdentity(declaration.identity);
        const matches = declarationsByIdentity.get(key) ?? [];
        matches.push(declaration);
        declarationsByIdentity.set(key, matches);
      }
    }
    return {
      byRelativePath,
      declarationsByIdentity,
      declarationsByRelativePath,
      diagnosticsByRelativePath,
      relativePathByAbsolute,
    };
  }

  private static sameRevision(current: WorkspaceFile, incoming: WorkspaceFile): boolean {
    return (
      current.relative === incoming.relative &&
      current.absolute === incoming.absolute &&
      current.metadata.changeToken === incoming.metadata.changeToken
    );
  }
}
