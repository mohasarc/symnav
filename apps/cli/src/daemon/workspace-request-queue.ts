import type { WorkspaceRequestQueueState } from "./daemon-protocol.js";

export class WorkspaceRequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingTasks = 0;
  private currentState: WorkspaceRequestQueueState = "accepting";

  get state(): WorkspaceRequestQueueState {
    return this.currentState;
  }

  get isIdle(): boolean {
    return this.pendingTasks === 0;
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.currentState !== "accepting") {
      return Promise.reject(new Error(`Workspace request queue is ${this.currentState}`));
    }
    this.pendingTasks += 1;
    const result = this.tail.then(task);
    this.tail = result.then(
      () => this.taskFinished(),
      () => this.taskFinished(),
    );
    return result;
  }

  async drain(): Promise<void> {
    if (this.currentState === "closed") return;
    this.currentState = "draining";
    await this.tail;
    this.currentState = "closed";
  }

  close(): void {
    this.currentState = "closed";
  }

  private taskFinished(): void {
    this.pendingTasks -= 1;
  }
}
