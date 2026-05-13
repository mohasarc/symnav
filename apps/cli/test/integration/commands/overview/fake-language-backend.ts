import type { FileSymbols, LanguageBackend } from "@symnav/core";

export interface FakeLanguageBackendOptions {
  accept?: (filePath: string) => boolean;
  symbols?: (filePath: string) => FileSymbols;
}

export class FakeLanguageBackend implements LanguageBackend {
  readonly calls: string[] = [];
  private readonly acceptFn: (filePath: string) => boolean;
  private readonly symbolsFn: (filePath: string) => FileSymbols;

  constructor(options: FakeLanguageBackendOptions = {}) {
    this.acceptFn = options.accept ?? (() => true);
    this.symbolsFn = options.symbols ?? ((filePath: string) => ({ filePath, symbols: [] }));
  }

  accepts(filePath: string): boolean {
    return this.acceptFn(filePath);
  }

  async fileSymbols(filePath: string): Promise<FileSymbols> {
    this.calls.push(filePath);
    return this.symbolsFn(filePath);
  }
}
