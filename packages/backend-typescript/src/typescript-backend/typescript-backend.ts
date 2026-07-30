import { basename } from "node:path";

import type {
  CallEdge,
  CallTargetResolution,
  FileSystem,
  LanguageBackend,
  OverviewFileSymbols,
  SymbolReference,
  ResolveSymbolsOptions,
  ResolvedPath,
  SymbolOverviewNode,
  SymbolIdentity,
} from "@symnav/core";
import { CollectingDiagnosticSink, FileNotFoundError } from "@symnav/core";

import { findCallees } from "../call-graph/find-callees.js";
import { findCallers } from "../call-graph/find-callers.js";
import { findCallTarget } from "../call-graph/find-call-target.js";
import { findDefinitions } from "../definition/find-definitions.js";
import { loadFileSymbols } from "../extract/load-file-symbols.js";
import { ReferenceFinder } from "../references/find-references.js";
import { resolveSymbols } from "../resolve/resolve-symbols.js";

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

  constructor(private readonly fs: FileSystem) {}

  accepts(filePath: string): boolean {
    return TypeScriptBackend.accepts(filePath);
  }

  async fileSymbols(file: ResolvedPath): Promise<OverviewFileSymbols> {
    if (!this.fs.existsSync(file.absolute) || this.fs.isDirectorySync(file.absolute)) {
      throw new FileNotFoundError(file.relative);
    }
    const diagnostics = new CollectingDiagnosticSink();
    const result = loadFileSymbols(this.fs, file, diagnostics);
    return withDiagnostics(result, diagnostics);
  }

  async resolveSymbols(
    files: readonly ResolvedPath[],
    query: string,
    options: ResolveSymbolsOptions,
  ): Promise<readonly SymbolOverviewNode[]> {
    return resolveSymbols({ fs: this.fs, files, query, options });
  }

  async findDefinitions(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolOverviewNode[]> {
    return findDefinitions({ fs: this.fs, files, identity });
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
    return findCallTarget({ fs: this.fs, files, identity });
  }

  async findCallees(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]> {
    return findCallees({ fs: this.fs, files, identity });
  }

  async findCallers(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]> {
    return findCallers({ fs: this.fs, files, identity });
  }
}

function withDiagnostics(
  result: OverviewFileSymbols,
  diagnostics: CollectingDiagnosticSink,
): OverviewFileSymbols {
  const collected = diagnostics.diagnostics();
  if (collected.length === 0) return result;
  return { ...result, diagnostics: collected };
}
