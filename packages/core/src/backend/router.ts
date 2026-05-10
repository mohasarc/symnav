import type { FileSymbols } from "../intermediate-representation/types.js";

export interface LanguageBackend {
  accepts(filePath: string): boolean;
  fileSymbols(filePath: string): Promise<FileSymbols>;
}

export class BackendRouter {
  readonly #backends: readonly LanguageBackend[];

  constructor(backends: readonly LanguageBackend[]) {
    this.#backends = backends;
  }

  find(filePath: string): LanguageBackend | undefined {
    for (const backend of this.#backends) {
      if (backend.accepts(filePath)) {
        return backend;
      }
    }
    return undefined;
  }
}
