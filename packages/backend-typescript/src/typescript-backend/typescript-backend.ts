import { basename } from "node:path";

import type {
  CallEdge,
  CallTargetResolution,
  BackendRefreshRequest,
  BackendRefreshSummary,
  FileSystem,
  LanguageBackend,
  OverviewFileEntries,
  SymbolReference,
  ResolveSymbolsOptions,
  ResolvedPath,
  SymbolOverviewNode,
  SymbolIdentity,
} from "@symnav/core";
import { FileNotFoundError, WorkspaceSourceCache } from "@symnav/core";

import { SymbolResolver } from "../resolve/resolve-symbols.js";
import { TypeScriptProjectGraph } from "./typescript-project-graph.js";
import type { TypeScriptSemanticQueryObserver } from "./typescript-semantic-query-observer.js";
import { TypeScriptSemanticQueryService } from "./typescript-semantic-query-service.js";
import {
  TypeScriptFileEntryExtractor,
  TypeScriptWorkspaceState,
  type TypeScriptFileExtractor,
} from "./typescript-workspace-state.js";

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

  private readonly state: TypeScriptWorkspaceState;
  private readonly projectGraph: TypeScriptProjectGraph | undefined;
  private readonly sourceCache: WorkspaceSourceCache | undefined;
  private readonly semanticQueries: TypeScriptSemanticQueryService;

  constructor(
    private readonly fs: FileSystem,
    state?: TypeScriptWorkspaceState,
    projectGraph?: TypeScriptProjectGraph,
    observer?: TypeScriptSemanticQueryObserver,
    extractor: TypeScriptFileExtractor = new TypeScriptFileEntryExtractor(),
  ) {
    if (state) {
      this.state = state;
      this.projectGraph = projectGraph;
      this.sourceCache = undefined;
      this.semanticQueries = new TypeScriptSemanticQueryService(
        this.projectGraph,
        this.state,
        observer,
      );
      return;
    }
    this.sourceCache = new WorkspaceSourceCache(fs);
    this.projectGraph = projectGraph ?? new TypeScriptProjectGraph(this.sourceCache, observer);
    this.state = new TypeScriptWorkspaceState(this.sourceCache, extractor, this.projectGraph);
    this.semanticQueries = new TypeScriptSemanticQueryService(
      this.projectGraph,
      this.state,
      observer,
    );
  }

  accepts(filePath: string): boolean {
    return TypeScriptBackend.accepts(filePath);
  }

  async refresh(request: BackendRefreshRequest): Promise<BackendRefreshSummary> {
    this.sourceCache?.refresh(request.snapshot);
    if (request.coverage === "workspace") await this.projectGraph?.refresh(request.snapshot);
    const summary = await this.state.refresh(request.snapshot.files, request.coverage);
    this.semanticQueries.beginTurn(request.snapshot);
    return summary;
  }

  async releaseTransientResources(): Promise<void> {
    this.semanticQueries.releaseTransientResources();
  }

  async fileEntries(file: ResolvedPath): Promise<OverviewFileEntries> {
    if (!this.fs.existsSync(file.absolute) || this.fs.isDirectorySync(file.absolute)) {
      throw new FileNotFoundError(file.relative);
    }
    return await this.state.fileEntries(file);
  }

  async resolveSymbols(
    files: readonly ResolvedPath[],
    query: string,
    options: ResolveSymbolsOptions,
  ): Promise<readonly SymbolOverviewNode[]> {
    return SymbolResolver.resolveSymbols({ state: this.state, files, query, options });
  }

  async declarations(files: readonly ResolvedPath[]): Promise<readonly SymbolOverviewNode[]> {
    return await this.state.declarations(files);
  }

  async findDefinitions(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolOverviewNode[]> {
    await this.state.ensureFiles(files);
    return this.semanticQueries.findDefinitions(identity);
  }

  async findReferences(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolReference[]> {
    await this.state.ensureFiles(files);
    return this.semanticQueries.findReferences(identity);
  }

  async findCallTarget(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<CallTargetResolution> {
    await this.state.ensureFiles(files);
    return this.semanticQueries.findCallTarget(identity);
  }

  async findCallees(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]> {
    await this.state.ensureFiles(files);
    return this.semanticQueries.findCallees(identity);
  }

  async findCallers(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]> {
    await this.state.ensureFiles(files);
    return this.semanticQueries.findCallers(identity);
  }
}
