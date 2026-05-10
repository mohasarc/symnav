import type { LanguageBackend } from "./language-backend.js";

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
