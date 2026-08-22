import { basename } from "node:path";

import type {
  CallEdge,
  CallTargetResolution,
  BackendRefreshSummary,
  FileSystem,
  LanguageBackend,
  OverviewFileEntries,
  SymbolReference,
  ResolveSymbolsOptions,
  ResolvedPath,
  SymbolOverviewNode,
  SymbolIdentity,
  WorkspaceFile,
} from "@symnav/core";
import { CollectingDiagnosticSink, FileNotFoundError } from "@symnav/core";

import { findCallees } from "../call-graph/find-callees.js";
import { findCallers } from "../call-graph/find-callers.js";
import { findCallTarget } from "../call-graph/find-call-target.js";
import { findDefinitions } from "../definition/find-definitions.js";
import { loadFileEntries } from "../extract/load-file-entries.js";
import { WorkspaceDeclarationIndex } from "../identity/workspace-declaration-index.js";
import { ReferenceFinder } from "../references/find-references.js";
import { SymbolResolver } from "../resolve/resolve-symbols.js";

export class TypeScriptBackend implements LanguageBackend {
  static readonly extensions: readonly string[] = [".d.ts", ".ts", ".tsx", ".mts", ".cts"];

  static accepts(filePath: string): boolean {
    const name = basename(filePath);
    for (const ext of TypeScriptBackend.extensions) {
      if (name.endsWith(ext)) {
        return true;
      }
    }
    return false;
  }

  private declarationIndex: WorkspaceDeclarationIndex | undefined;

  constructor(private readonly fs: FileSystem) {}

  declare readonly refresh: (
    files: readonly WorkspaceFile[],
  ) => Promise<BackendRefreshSummary>;

  private sharedDeclarationIndex(): WorkspaceDeclarationIndex {
    this.declarationIndex ??= new WorkspaceDeclarationIndex(this.fs);
    return this.declarationIndex;
  }

  accepts(filePath: string): boolean {
    return TypeScriptBackend.accepts(filePath);
  }

  async fileEntries(file: ResolvedPath): Promise<OverviewFileEntries> {
    if (!this.fs.existsSync(file.absolute) || this.fs.isDirectorySync(file.absolute)) {
      throw new FileNotFoundError(file.relative);
    }
    const diagnostics = new CollectingDiagnosticSink();
    const result = loadFileEntries(this.fs, file, diagnostics);
    return withDiagnostics(result, diagnostics);
  }

  async resolveSymbols(
    files: readonly ResolvedPath[],
    query: string,
    options: ResolveSymbolsOptions,
  ): Promise<readonly SymbolOverviewNode[]> {
    return SymbolResolver.resolveSymbols({ fs: this.fs, files, query, options });
  }

  async declarations(files: readonly ResolvedPath[]): Promise<readonly SymbolOverviewNode[]> {
    const declarationIndex = this.sharedDeclarationIndex();
    declarationIndex.ensureFiles(files);
    return files.flatMap((file) => declarationIndex.declarationsIn(file.relative) ?? []);
  }

  async findDefinitions(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolOverviewNode[]> {
    return findDefinitions({ declarationIndex: this.sharedDeclarationIndex(), files, identity });
  }

  async findReferences(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolReference[]> {
    return new ReferenceFinder({ fs: this.fs, files, identity }).find();
  }

  async findCallTarget(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<CallTargetResolution> {
    return findCallTarget({ declarationIndex: this.sharedDeclarationIndex(), files, identity });
  }

  async findCallees(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]> {
    return findCallees({ declarationIndex: this.sharedDeclarationIndex(), files, identity });
  }

  async findCallers(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]> {
    return findCallers({ declarationIndex: this.sharedDeclarationIndex(), files, identity });
  }
}

function withDiagnostics(
  result: OverviewFileEntries,
  diagnostics: CollectingDiagnosticSink,
): OverviewFileEntries {
  const collected = diagnostics.diagnostics();
  if (collected.length === 0) return result;
  return { ...result, diagnostics: collected };
}
