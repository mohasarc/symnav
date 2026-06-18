import type {
  LanguageBackend,
  OverviewFileSymbols,
  SymbolReference,
  ResolvedPath,
  SymbolDecl,
} from "@symnav/core";

export interface FakeLanguageBackendOptions {
  accept?: (filePath: string) => boolean;
  symbols?: (filePath: string) => OverviewFileSymbols;
}

export class FakeLanguageBackend implements LanguageBackend {
  readonly calls: string[] = [];
  private readonly acceptFn: (filePath: string) => boolean;
  private readonly symbolsFn: (filePath: string) => OverviewFileSymbols;

  constructor(options: FakeLanguageBackendOptions = {}) {
    this.acceptFn = options.accept ?? (() => true);
    this.symbolsFn = options.symbols ?? ((filePath: string) => ({ file: filePath, symbols: [] }));
  }

  accepts(filePath: string): boolean {
    return this.acceptFn(filePath);
  }

  async fileSymbols(path: ResolvedPath): Promise<OverviewFileSymbols> {
    this.calls.push(path.relative);
    return this.symbolsFn(path.relative);
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
}
