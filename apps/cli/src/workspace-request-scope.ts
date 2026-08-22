import type {
  BackendRefreshSummary,
  BackendRouter,
  Workspace,
  WorkspaceSnapshot,
} from "@symnav/core";

export interface PreparedCommandScope {
  readonly workspace: Workspace;
  readonly snapshot: WorkspaceSnapshot;
  readonly router: BackendRouter;
  readonly refresh: BackendRefreshSummary;
}
