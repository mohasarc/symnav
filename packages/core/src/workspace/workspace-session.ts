import type { BackendRouter } from "../backend/backend-router.js";
import type {
  BackendRefreshCoverage,
  BackendRefreshSummary,
  LanguageBackend,
} from "../backend/language-backend.js";
import type { FileSystem } from "./file-system.js";
import type { Workspace, WorkspaceSnapshot } from "./workspace.js";

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
  constructor(options: {
    readonly fileSystem: FileSystem;
    readonly backends: readonly LanguageBackend[];
    readonly discoveryRetention: WorkspaceDiscoveryRetention;
  }) {
    void options;
  }

  async prepare(
    startDirectory: string,
    preparation: WorkspacePreparation = { coverage: "workspace" },
  ): Promise<PreparedWorkspaceScope> {
    void startDirectory;
    void preparation;
    throw new Error("Workspace session preparation is not implemented");
  }

  openWorkspace(startDirectory: string, coverage: BackendRefreshCoverage): Promise<Workspace> {
    void startDirectory;
    void coverage;
    throw new Error("Workspace session discovery is not implemented");
  }

  async prepareWorkspace(
    workspace: Workspace,
    preparation: WorkspacePreparation,
  ): Promise<PreparedWorkspaceScope> {
    void workspace;
    void preparation;
    throw new Error("Workspace turn preparation is not implemented");
  }

  async releaseTransientResources(): Promise<void> {
    throw new Error("Workspace session release is not implemented");
  }
}
