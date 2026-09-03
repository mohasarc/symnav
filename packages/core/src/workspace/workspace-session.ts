import { BackendRouter } from "../backend/backend-router.js";
import type {
  BackendRefreshCoverage,
  BackendRefreshSummary,
  LanguageBackend,
} from "../backend/language-backend.js";
import type { FileSystem } from "./file-system.js";
import { WorkspaceCatalog } from "./workspace-catalog.js";
import { createWorkspace, type Workspace, type WorkspaceSnapshot } from "./workspace.js";

export type WorkspaceDiscoveryRetention = "request" | "session";

export type WorkspaceSnapshotSelector = (
  workspace: Workspace,
  router: BackendRouter,
) => Promise<WorkspaceSnapshot>;

export type WorkspacePreparation =
  | { readonly coverage: "workspace" }
  | {
      readonly coverage: "selection";
      readonly selectSnapshot: WorkspaceSnapshotSelector;
    };

export interface PreparedWorkspaceScope {
  readonly workspace: Workspace;
  readonly snapshot: WorkspaceSnapshot;
  readonly router: BackendRouter;
  readonly refresh: BackendRefreshSummary;
}

export class WorkspaceSession {
  readonly #fileSystem: FileSystem;
  readonly #backends: readonly LanguageBackend[];
  readonly #catalog: WorkspaceCatalog | undefined;

  constructor(options: {
    readonly fileSystem: FileSystem;
    readonly backends: readonly LanguageBackend[];
    readonly discoveryRetention: WorkspaceDiscoveryRetention;
  }) {
    this.#fileSystem = options.fileSystem;
    this.#backends = Object.freeze([...options.backends]);
    this.#catalog =
      options.discoveryRetention === "session"
        ? new WorkspaceCatalog(options.fileSystem)
        : undefined;
  }

  async prepare(
    startDirectory: string,
    preparation: WorkspacePreparation = { coverage: "workspace" },
  ): Promise<PreparedWorkspaceScope> {
    const workspace = await this.openWorkspace(startDirectory, preparation.coverage);
    return this.prepareWorkspace(workspace, preparation);
  }

  openWorkspace(startDirectory: string, coverage: BackendRefreshCoverage): Promise<Workspace> {
    if (coverage === "selection" || this.#catalog === undefined) {
      return createWorkspace({ startDir: startDirectory, fs: this.#fileSystem });
    }
    return this.#catalog.refresh(startDirectory);
  }

  async prepareWorkspace(
    workspace: Workspace,
    preparation: WorkspacePreparation,
  ): Promise<PreparedWorkspaceScope> {
    const router = new BackendRouter(this.#backends);
    const snapshot =
      preparation.coverage === "selection"
        ? await preparation.selectSnapshot(workspace, router)
        : await workspace.snapshot();
    const refresh = await router.refresh(snapshot, preparation.coverage);
    return { workspace, snapshot, router, refresh };
  }

  async releaseTransientResources(): Promise<void> {
    throw new Error("Workspace session release is not implemented");
  }
}
