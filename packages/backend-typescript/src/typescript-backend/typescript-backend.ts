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
import { FileNotFoundError } from "@symnav/core";

import { findCallees } from "../call-graph/find-callees.js";
import { findCallers } from "../call-graph/find-callers.js";
import { findCallTarget } from "../call-graph/find-call-target.js";
import { findDefinitions } from "../definition/find-definitions.js";
import { ReferenceFinder } from "../references/find-references.js";
import { SymbolResolver } from "../resolve/resolve-symbols.js";
import { TypeScriptProjectGraph } from "./typescript-project-graph.js";
import {
  TypeScriptFileEntryExtractor,
  TypeScriptWorkspaceState,
} from "./typescript-workspace-state.js";
import { WorkspaceSourceCache } from "./workspace-source-cache.js";

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

  constructor(
    private readonly fs: FileSystem,
    state?: TypeScriptWorkspaceState,
    projectGraph?: TypeScriptProjectGraph,
  ) {
    if (state) {
      this.state = state;
      this.projectGraph = projectGraph;
      this.sourceCache = undefined;
      return;
    }
    this.sourceCache = new WorkspaceSourceCache(fs);
    this.projectGraph = projectGraph ?? new TypeScriptProjectGraph(this.sourceCache);
    this.state = new TypeScriptWorkspaceState(
      this.sourceCache,
      new TypeScriptFileEntryExtractor(),
      this.projectGraph,
    );
  }

  accepts(filePath: string): boolean {
    return TypeScriptBackend.accepts(filePath);
  }

  async refresh(request: BackendRefreshRequest): Promise<BackendRefreshSummary> {
    this.sourceCache?.refresh(request.snapshot);
    await this.projectGraph?.refresh(request.snapshot);
    return this.state.refresh(request.snapshot.files, request.coverage);
  }

  async releaseTransientResources(): Promise<void> {
    this.projectGraph?.releaseTransientResources();
  }

  async fileEntries(file: ResolvedPath): Promise<OverviewFileEntries> {
    if (!this.fs.existsSync(file.absolute) || this.fs.isDirectorySync(file.absolute)) {
      throw new FileNotFoundError(file.relative);
    }
    return this.state.fileEntries(file);
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
