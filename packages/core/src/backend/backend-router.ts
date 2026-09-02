import { UnsupportedFileError } from "./errors.js";
import type {
  BackendRefreshCoverage,
  BackendRefreshSummary,
  LanguageBackend,
} from "./language-backend.js";
import type { WorkspaceFile, WorkspaceSnapshot } from "../workspace/workspace.js";

export class BackendRouter {
  readonly #backends: readonly LanguageBackend[];

  constructor(backends: readonly LanguageBackend[]) {
    this.#backends = backends;
  }

  async refresh(
    snapshot: WorkspaceSnapshot,
    coverage: BackendRefreshCoverage = "workspace",
  ): Promise<BackendRefreshSummary> {
    const filesByBackend = new Map<LanguageBackend, WorkspaceFile[]>();
    for (const backend of this.#backends) {
      filesByBackend.set(backend, []);
    }
    for (const file of snapshot.files) {
      const backend = this.find(file.relative);
      if (backend) {
        filesByBackend.get(backend)?.push(file);
      }
    }

    let total: BackendRefreshSummary = { added: 0, changed: 0, removed: 0, unchanged: 0 };
    for (const backend of this.#backends) {
      const summary = await backend.refresh(filesByBackend.get(backend) ?? [], coverage);
      total = {
        added: total.added + summary.added,
        changed: total.changed + summary.changed,
        removed: total.removed + summary.removed,
        unchanged: total.unchanged + summary.unchanged,
      };
    }
    return total;
  }

  find(filePath: string): LanguageBackend | undefined {
    for (const backend of this.#backends) {
      if (backend.accepts(filePath)) {
        return backend;
      }
    }
    return undefined;
  }

  findOrThrow(filePath: string): LanguageBackend {
    const backend = this.find(filePath);
    if (backend === undefined) {
      throw new UnsupportedFileError(filePath);
    }
    return backend;
  }
}
