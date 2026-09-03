import type { NavigationDiagnostic } from "../diagnostics/navigation-diagnostic.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import type {
  OverviewFileEntries,
  SymbolOverviewNode,
} from "../intermediate-representation/overview-tree.js";
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

export abstract class RevisionedBackendState<PreparedDetails> {
  protected constructor(protected readonly fileSystem: FileSystem) {}

  abstract refresh(
    files: readonly WorkspaceFile[],
    coverage?: BackendRefreshCoverage,
  ): Promise<BackendRefreshSummary>;
  abstract ensureFiles(files: readonly ResolvedPath[]): Promise<void>;
  abstract fileEntries(file: ResolvedPath): Promise<OverviewFileEntries>;
  abstract declarations(files: readonly ResolvedPath[]): Promise<readonly SymbolOverviewNode[]>;
  abstract diagnostics(file: ResolvedPath): readonly NavigationDiagnostic[];
  abstract declarationsIn(relativePath: string): readonly SymbolOverviewNode[] | undefined;
  abstract declarationForIdentity(identity: SymbolIdentity): IndexedBackendDeclaration | undefined;
  abstract currentFileCount(): number;
  protected abstract preparedFile(
    relativePath: string,
  ): RevisionedBackendPreparedFile<PreparedDetails> | undefined;
  protected abstract preparedFiles(): readonly RevisionedBackendPreparedFile<PreparedDetails>[];
  protected abstract relativePathForAbsolute(absolutePath: string): string | undefined;
  protected abstract createPreparation(
    request: RevisionedBackendPreparationRequest<PreparedDetails>,
  ): RevisionedBackendPreparation<PreparedDetails>;
}
