import type { FileSymbols } from "./ir.js";

export interface LanguageBackend {
  accepts(filePath: string): boolean;
  fileSymbols(filePath: string): Promise<FileSymbols>;
}

export class BackendRouter {
  private readonly backends: readonly LanguageBackend[];

  constructor(backends: readonly LanguageBackend[]) {
    this.backends = backends;
  }

  find(filePath: string): LanguageBackend | undefined {
    return this.backends.find((b) => b.accepts(filePath));
  }
}
