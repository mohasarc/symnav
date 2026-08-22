import type { WorkspaceRequestQueueState } from "./daemon-protocol.js";

export class WorkspaceRequestQueue {
  private tail: Promise<void> = Promise.resolve();

  get state(): WorkspaceRequestQueueState {
    throw new Error("Workspace request queue state is not implemented");
  }

  get isIdle(): boolean {
    throw new Error("Workspace request queue idle tracking is not implemented");
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  drain(): Promise<void> {
    throw new Error("Workspace request queue draining is not implemented");
  }

  close(): void {
    throw new Error("Workspace request queue closure is not implemented");
  }
}
