import type { WorkspaceRequestQueueState } from "./daemon-protocol.js";

export class WorkspaceRequestQueue {
  get state(): WorkspaceRequestQueueState {
    throw new Error("Workspace request queue state is not implemented");
  }

  get isIdle(): boolean {
    throw new Error("Workspace request queue idle tracking is not implemented");
  }

  enqueue<T>(_task: () => Promise<T>): Promise<T> {
    throw new Error("Workspace request queue execution is not implemented");
  }

  drain(): Promise<void> {
    throw new Error("Workspace request queue draining is not implemented");
  }

  close(): void {
    throw new Error("Workspace request queue closure is not implemented");
  }
}
