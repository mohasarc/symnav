import type { WorkspaceRequestQueueState } from "./daemon-protocol.js";

export type DaemonCommandName =
  | "overview"
  | "resolve"
  | "def"
  | "refs"
  | "context"
  | "graph"
  | "stats"
  | "help"
  | "version"
  | "unknown";

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

export class WorkspaceRequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly admitted: WorkspaceQueuedRequest[] = [];
  private activeRequest: WorkspaceActiveRequest | undefined;
  private currentState: WorkspaceRequestQueueState = "accepting";
  private compatibilityRequestId = 0;

  constructor(private readonly now: () => number = Date.now) {}

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
    return this.activeRequest === undefined && this.admitted.length === 0;
  }

  enqueue<T>(metadata: WorkspaceQueuedRequest, execute: () => Promise<T>): Promise<T>;
  enqueue<T>(execute: () => Promise<T>): Promise<T>;
  enqueue<T>(
    metadataOrExecute: WorkspaceQueuedRequest | (() => Promise<T>),
    requestedExecution?: () => Promise<T>,
  ): Promise<T> {
    if (this.currentState !== "accepting") {
      return Promise.reject(new Error(`Workspace request queue is ${this.currentState}`));
    }
    const metadata =
      typeof metadataOrExecute === "function"
        ? {
            requestId: `compatibility-${this.compatibilityRequestId++}`,
            command: "unknown" as const,
            acceptedAt: this.now(),
          }
        : metadataOrExecute;
    const execute =
      typeof metadataOrExecute === "function" ? metadataOrExecute : requestedExecution;
    if (execute === undefined)
      return Promise.reject(new Error("Workspace request has no execution"));
    this.admitted.push(Object.freeze({ ...metadata }));
    const result = this.tail.then(async () => {
      const admitted = this.admitted.shift();
      if (admitted === undefined || admitted.requestId !== metadata.requestId) {
        throw new Error("Workspace request queue admission order changed");
      }
      this.activeRequest = Object.freeze({ ...admitted, startedAt: this.now() });
      try {
        return await execute();
      } finally {
        this.activeRequest = undefined;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async drain(): Promise<void> {
    if (this.currentState !== "closed") this.currentState = "draining";
    await this.tail;
    this.currentState = "closed";
  }

  close(): void {
    this.currentState = "closed";
  }
}
