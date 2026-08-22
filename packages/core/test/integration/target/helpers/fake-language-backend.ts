import type {
  CallEdge,
  CallTargetResolution,
  BackendRefreshSummary,
  LanguageBackend,
  OverviewFileEntries,
  SymbolReference,
  ResolvedPath,
  WorkspaceFile,
  SymbolOverviewNode,
} from "../../../../src/index.js";

export interface FakeLanguageBackendOptions {
  accept?: (filePath: string) => boolean;
  entries?: (filePath: string) => OverviewFileEntries;
  declarations?: readonly SymbolOverviewNode[];
}

export class FakeLanguageBackend implements LanguageBackend {
  readonly calls: string[] = [];
  readonly declarationCalls: string[][] = [];
  private readonly acceptFn: (filePath: string) => boolean;
  private readonly entriesFn: (filePath: string) => OverviewFileEntries;
  private readonly declarationSymbols: readonly SymbolOverviewNode[];

  constructor(options: FakeLanguageBackendOptions = {}) {
    this.acceptFn = options.accept ?? (() => true);
    this.entriesFn = options.entries ?? ((filePath: string) => ({ file: filePath, entries: [] }));
    this.declarationSymbols = options.declarations ?? [];
  }

  accepts(filePath: string): boolean {
    return this.acceptFn(filePath);
  }

  async refresh(files: readonly WorkspaceFile[]): Promise<BackendRefreshSummary> {
    return { added: files.length, changed: 0, removed: 0, unchanged: 0 };
  }

  async fileEntries(path: ResolvedPath): Promise<OverviewFileEntries> {
    this.calls.push(path.relative);
    return this.entriesFn(path.relative);
  }

  async resolveSymbols(): Promise<readonly SymbolOverviewNode[]> {
    return [];
  }

  async declarations(files: readonly ResolvedPath[]): Promise<readonly SymbolOverviewNode[]> {
    this.declarationCalls.push(files.map((file) => file.relative));
    const suppliedFiles = new Set(files.map((file) => file.relative));
    return this.declarationSymbols.filter((symbol) => suppliedFiles.has(symbol.identity.file));
  }

  async findDefinitions(): Promise<readonly SymbolOverviewNode[]> {
    return [];
  }

  async findReferences(): Promise<readonly SymbolReference[]> {
    return [];
  }

  async findCallTarget(): Promise<CallTargetResolution> {
    return { outcome: "not-found" };
  }

  async findCallees(): Promise<readonly CallEdge[]> {
    return [];
  }

  async findCallers(): Promise<readonly CallEdge[]> {
    return [];
  }
}
