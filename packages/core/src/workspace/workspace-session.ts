import type { BackendRouter } from "../backend/backend-router.js";
import type {
  BackendRefreshSummary,
} from "../backend/language-backend.js";
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
