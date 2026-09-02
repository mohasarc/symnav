import {
  BackendRouter,
  createWorkspace,
  type BackendRefreshCoverage,
  type BackendRefreshSummary,
  type FileSystem,
  type LanguageBackend,
  type Workspace,
  type WorkspaceSnapshot,
} from "@symnav/core";

export interface PreparedCommandScope {
  readonly workspace: Workspace;
  readonly snapshot: WorkspaceSnapshot;
  readonly router: BackendRouter;
  readonly refresh: BackendRefreshSummary;
}

export class WorkspaceRequestScopeFactory {
  constructor(
    private readonly fs: FileSystem,
    private readonly backends: readonly LanguageBackend[],
  ) {}

  async prepare(
    startDir: string,
    selectSnapshot?: (workspace: Workspace, router: BackendRouter) => Promise<WorkspaceSnapshot>,
  ): Promise<PreparedCommandScope> {
    const workspace = await createWorkspace({ startDir, fs: this.fs });
    return this.prepareWorkspace(workspace, selectSnapshot);
  }

  async prepareWorkspace(
    workspace: Workspace,
    selectSnapshot?: (workspace: Workspace, router: BackendRouter) => Promise<WorkspaceSnapshot>,
  ): Promise<PreparedCommandScope> {
    const router = new BackendRouter(this.backends);
    const snapshot = selectSnapshot
      ? await selectSnapshot(workspace, router)
      : await workspace.snapshot();
    const coverage: BackendRefreshCoverage = selectSnapshot ? "selection" : "workspace";
    const refresh = await router.refresh(snapshot, coverage);
    return { workspace, snapshot, router, refresh };
  }
}
