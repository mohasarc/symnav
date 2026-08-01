import { basename } from "node:path";

import type {
  CallEdge,
  CallTargetResolution,
  FileSystem,
  LanguageBackend,
  OverviewFileEntries,
  SymbolReference,
  ResolveSymbolTargetOptions,
  ResolveSymbolsOptions,
  ResolvedPath,
  SymbolOverviewNode,
  SymbolIdentity,
  SymbolTargetCandidate,
  SymbolTargetPattern,
} from "@symnav/core";
import { CollectingDiagnosticSink, FileNotFoundError } from "@symnav/core";

import { findCallees } from "../call-graph/find-callees.js";
import { findCallers } from "../call-graph/find-callers.js";
import { findCallTarget } from "../call-graph/find-call-target.js";
import { findDefinitions } from "../definition/find-definitions.js";
import { loadFileEntries } from "../extract/load-file-entries.js";
import { WorkspaceDeclarationIndex } from "../identity/workspace-declaration-index.js";
import { ReferenceFinder } from "../references/find-references.js";
import { resolveSymbols } from "../resolve/resolve-symbols.js";
import { findTargetCandidates } from "../target/resolve-symbol-target.js";

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
    return resolveSymbols({ fs: this.fs, files, query, options });
  }

  async findTargetCandidates(
    files: readonly ResolvedPath[],
    pattern: SymbolTargetPattern,
    options: ResolveSymbolTargetOptions,
  ): Promise<readonly SymbolTargetCandidate[]> {
    return findTargetCandidates({ index: this.sharedDeclarationIndex(), files, pattern, options });
  }

  async findDefinitions(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolOverviewNode[]> {
    return findDefinitions({ index: this.sharedDeclarationIndex(), files, identity });
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
    return findCallTarget({ index: this.sharedDeclarationIndex(), files, identity });
  }

  async findCallees(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]> {
    return findCallees({ index: this.sharedDeclarationIndex(), files, identity });
  }

  async findCallers(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]> {
    return findCallers({ index: this.sharedDeclarationIndex(), files, identity });
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
