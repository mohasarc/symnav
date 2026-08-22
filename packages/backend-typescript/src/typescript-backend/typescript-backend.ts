import { basename } from "node:path";

import type {
  CallEdge,
  CallTargetResolution,
  BackendRefreshCoverage,
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
import { ReferenceFinder } from "../references/find-references.js";
import { SymbolResolver } from "../resolve/resolve-symbols.js";
import { TypeScriptWorkspaceState } from "./typescript-workspace-state.js";

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

  constructor(
    private readonly fs: FileSystem,
    private readonly state = new TypeScriptWorkspaceState(fs),
  ) {}

  accepts(filePath: string): boolean {
    return TypeScriptBackend.accepts(filePath);
  }

  async refresh(
    files: readonly WorkspaceFile[],
    coverage: BackendRefreshCoverage = "workspace",
  ): Promise<BackendRefreshSummary> {
    return this.state.refresh(files, coverage);
  }

  async fileEntries(file: ResolvedPath): Promise<OverviewFileEntries> {
    if (!this.fs.existsSync(file.absolute) || this.fs.isDirectorySync(file.absolute)) {
      throw new FileNotFoundError(file.relative);
    }
    const diagnostics = new CollectingDiagnosticSink();
    const result = this.state.fileEntries(file, diagnostics);
    return withDiagnostics(result, diagnostics);
  }

  async resolveSymbols(
    files: readonly ResolvedPath[],
    query: string,
    options: ResolveSymbolsOptions,
  ): Promise<readonly SymbolOverviewNode[]> {
    return SymbolResolver.resolveSymbols({ state: this.state, files, query, options });
  }

  async declarations(files: readonly ResolvedPath[]): Promise<readonly SymbolOverviewNode[]> {
    return this.state.allDeclarations(files);
  }

  async findDefinitions(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolOverviewNode[]> {
    return findDefinitions({ workspaceState: this.state, files, identity });
  }

  async findReferences(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolReference[]> {
    return new ReferenceFinder({ state: this.state, files, identity }).find();
  }

  async findCallTarget(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<CallTargetResolution> {
    return findCallTarget({ workspaceState: this.state, files, identity });
  }

  async findCallees(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]> {
    return findCallees({ workspaceState: this.state, files, identity });
  }

  async findCallers(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]> {
    return findCallers({ workspaceState: this.state, files, identity });
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
