import type { FileSymbols } from "../intermediate-representation/types.js";

/**
 * Cross-language contract for a symnav language backend. A backend is
 * responsible for producing symbol IR for files in a given language. The
 * caller (typically `runOverview`) handles workspace-level concerns like
 * existence, ignore, and outside-workspace checks before invoking
 * `fileSymbols`.
 */
export interface LanguageBackend {
  /**
   * Whether this backend can produce IR for the given workspace-relative
   * path. Implementations should be cheap (extension check or similar) and
   * deterministic — `find()` may call this repeatedly.
   */
  accepts(filePath: string): boolean;

  /**
   * Produce the file's symbol IR. Caller guarantees the path is in-workspace
   * and not ignored. Throws a `BackendError` subclass on failure.
   */
  fileSymbols(filePath: string): Promise<FileSymbols>;
}

/**
 * Selects the first registered `LanguageBackend` whose `accepts()` returns
 * true for a given path. Registration order is significant — backends tried
 * in array order, first match wins.
 */
export class BackendRouter {
  readonly #backends: readonly LanguageBackend[];

  constructor(backends: readonly LanguageBackend[]) {
    this.#backends = backends;
  }

  /** Returns the first registered backend that accepts the path, or undefined. */
  find(filePath: string): LanguageBackend | undefined {
    for (const backend of this.#backends) {
      if (backend.accepts(filePath)) {
        return backend;
      }
    }
    return undefined;
  }
}
