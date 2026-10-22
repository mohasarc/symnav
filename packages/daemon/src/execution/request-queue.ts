import type { DaemonCommandName, WorkspaceRequestQueueState } from "@symnav/daemon";
import { NodeDaemonClock, type DaemonClock } from "../lifecycle/daemon-clock.js";

export interface WorkspaceQueuedRequest {
  readonly requestId: string;
  readonly command: DaemonCommandName;
  readonly acceptedAt: number;
}

export interface WorkspaceActiveRequest extends WorkspaceQueuedRequest {
  readonly startedAt: number;
}

export interface WorkspaceRequestQueueSnapshot {
  readonly state: WorkspaceRequestQueueState;
  readonly active?: WorkspaceActiveRequest;
  readonly queued: number;
}

interface ScheduledBoundary {
  readonly operation: () => Promise<void>;
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export class WorkspaceRequestQueue {
  private readonly admitted: WorkspaceQueuedRequest[] = [];
  private readonly requestOperations: (() => Promise<void>)[] = [];
  private readonly idleWaiters: (() => void)[] = [];
  private activeRequest: WorkspaceActiveRequest | undefined;
  private scheduledBoundary: ScheduledBoundary | undefined;
  private running = false;
  private currentState: WorkspaceRequestQueueState = "accepting";

  constructor(
    private readonly clock: Pick<DaemonClock, "monotonicNowMs"> = new NodeDaemonClock(),
  ) {}

  get state(): WorkspaceRequestQueueState {
    return this.currentState;
  }

  get snapshot(): WorkspaceRequestQueueSnapshot {
    const active =
      this.activeRequest === undefined ? undefined : Object.freeze({ ...this.activeRequest });
    return Object.freeze({
      state: this.currentState,
      ...(active === undefined ? {} : { active }),
      queued: this.admitted.length,
    });
  }

  get isIdle(): boolean {
    return (
      this.activeRequest === undefined &&
      this.admitted.length === 0 &&
      this.scheduledBoundary === undefined
    );
  }

  enqueue<T>(metadata: WorkspaceQueuedRequest, execute: () => Promise<T>): Promise<T> {
    if (this.currentState !== "accepting") {
      return Promise.reject(new Error(`Workspace request queue is ${this.currentState}`));
    }
    this.admitted.push(Object.freeze({ ...metadata }));
    const result = new Promise<T>((resolve, reject) => {
      this.requestOperations.push(async () => {
        const admitted = this.admitted.shift();
        if (admitted === undefined || admitted.requestId !== metadata.requestId) {
          reject(new Error("Workspace request queue admission order changed"));
          return;
        }
        this.activeRequest = Object.freeze({
          ...admitted,
          startedAt: this.clock.monotonicNowMs(),
        });
        try {
          resolve(await execute());
        } catch (error) {
          reject(error);
        } finally {
          this.activeRequest = undefined;
        }
      });
    });
    void this.run();
    return result;
  }

  scheduleAtTurnBoundary(operation: () => Promise<void>): Promise<void> {
    if (this.scheduledBoundary !== undefined) return this.scheduledBoundary.completion;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    this.scheduledBoundary = { operation, completion, resolve, reject };
    void this.run();
    return completion;
  }

  async drain(): Promise<void> {
    if (this.currentState !== "closed") this.currentState = "draining";
    await this.waitForIdle();
    this.currentState = "closed";
  }

  close(): void {
    this.currentState = "closed";
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.scheduledBoundary !== undefined || this.requestOperations.length > 0) {
        if (this.scheduledBoundary !== undefined) {
          await this.runScheduledBoundary(this.scheduledBoundary);
          continue;
        }
        await this.requestOperations.shift()?.();
      }
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      if (this.scheduledBoundary !== undefined || this.requestOperations.length > 0) {
        void this.run();
      }
    }
  }

  private async runScheduledBoundary(boundary: ScheduledBoundary): Promise<void> {
    try {
      await boundary.operation();
      boundary.resolve();
    } catch (error) {
      boundary.reject(error);
    } finally {
      if (this.scheduledBoundary === boundary) this.scheduledBoundary = undefined;
    }
  }

  private waitForIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
