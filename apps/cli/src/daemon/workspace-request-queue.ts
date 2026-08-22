import type { WorkspaceRequestQueueState } from "./daemon-protocol.js";

export class WorkspaceRequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingTasks = 0;

  get state(): WorkspaceRequestQueueState {
    throw new Error("Workspace request queue state is not implemented");
  }

  get isIdle(): boolean {
    return this.pendingTasks === 0;
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.pendingTasks += 1;
    const result = this.tail.then(task);
    this.tail = result.then(
      () => this.taskFinished(),
      () => this.taskFinished(),
    );
    return result;
  }

  drain(): Promise<void> {
    throw new Error("Workspace request queue draining is not implemented");
  }

  close(): void {
    throw new Error("Workspace request queue closure is not implemented");
  }

  private taskFinished(): void {
    this.pendingTasks -= 1;
  }
}
