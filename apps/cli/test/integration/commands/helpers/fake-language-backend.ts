import type {
  CallEdge,
  CallTargetResolution,
  LanguageBackend,
  OverviewFileSymbols,
  SymbolReference,
  ResolvedPath,
  SymbolDecl,
} from "@symnav/core";

export interface FakeLanguageBackendOptions {
  accept?: (filePath: string) => boolean;
  entries?: (filePath: string) => OverviewFileSymbols;
}

export class FakeLanguageBackend implements LanguageBackend {
  readonly calls: string[] = [];
  private readonly acceptFn: (filePath: string) => boolean;
  private readonly entriesFn: (filePath: string) => OverviewFileSymbols;

  constructor(options: FakeLanguageBackendOptions = {}) {
    this.acceptFn = options.accept ?? (() => true);
    this.entriesFn = options.entries ?? ((filePath: string) => ({ file: filePath, entries: [] }));
  }

  accepts(filePath: string): boolean {
    return this.acceptFn(filePath);
  }

  async fileSymbols(path: ResolvedPath): Promise<OverviewFileSymbols> {
    this.calls.push(path.relative);
    return this.entriesFn(path.relative);
  }

  async resolveSymbols(): Promise<readonly SymbolDecl[]> {
    return [];
  }

  async findDefinitions(): Promise<readonly SymbolDecl[]> {
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
