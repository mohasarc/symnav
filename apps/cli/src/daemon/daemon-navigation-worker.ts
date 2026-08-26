import { Worker } from "node:worker_threads";
import type { CliExecutionRequest } from "../command-execution-result.js";
import {
  DaemonNavigationWorkerProtocol,
  type DaemonNavigationWorkerRequest,
  type DaemonNavigationWorkerResponse,
} from "./daemon-navigation-worker-protocol.js";

export interface DaemonNavigationWorkerExit {
  readonly generation: number;
  readonly cause: "closed" | "terminated" | "out-of-memory" | "error";
  readonly errorName?: string;
}

export class DaemonNavigationWorkerExitedError extends Error {
  constructor(
    readonly exit: DaemonNavigationWorkerExit,
    message = `Daemon navigation worker exited (${exit.cause})`,
  ) {
    super(message);
    this.name = "DaemonNavigationWorkerExitedError";
  }
}

export interface DaemonNavigationWorker {
  readonly generation: number;
  readonly exited: Promise<DaemonNavigationWorkerExit>;
  start(workspaceRoot: string): Promise<DaemonNavigationWorkerResponse>;
  execute(requestId: string, request: CliExecutionRequest): Promise<DaemonNavigationWorkerResponse>;
  releaseTransientResources(): Promise<DaemonNavigationWorkerResponse>;
  drainAndClose(): Promise<void>;
  terminate(): Promise<void>;
}

export interface NodeDaemonNavigationWorkerOptions {
  readonly generation: number;
  readonly stateDirectory: string;
  readonly entryUrl?: URL;
  readonly workerData?: Readonly<Record<string, unknown>>;
}

interface PendingWorkerResponse {
  readonly resolve: (response: DaemonNavigationWorkerResponse) => void;
  readonly reject: (error: Error) => void;
}

export class NodeDaemonNavigationWorker implements DaemonNavigationWorker {
  readonly generation: number;
  readonly exited: Promise<DaemonNavigationWorkerExit>;
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingWorkerResponse>();
  private readonly completed = new Set<string>();
  private resolveExited!: (exit: DaemonNavigationWorkerExit) => void;
  private exit: DaemonNavigationWorkerExit | undefined;
  private terminating = false;
  private closeAcknowledged = false;
  private communicationErrorName: string | undefined;

  constructor(options: NodeDaemonNavigationWorkerOptions) {
    this.generation = options.generation;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.worker = new Worker(
      options.entryUrl ?? new URL("./daemon-navigation-worker-entry.js", import.meta.url),
      {
        workerData: {
          stateDirectory: options.stateDirectory,
          generation: options.generation,
          ...options.workerData,
        },
      },
    );
    this.worker.on("message", (value: unknown) => this.receive(value));
    this.worker.once("error", (error) => this.failCommunication(error));
    this.worker.once("exit", () => this.finishExit());
  }

  start(workspaceRoot: string): Promise<DaemonNavigationWorkerResponse> {
    return this.send("initialize", {
      kind: "initialize",
      generation: this.generation,
      workspaceRoot,
    });
  }

  execute(
    requestId: string,
    request: CliExecutionRequest,
  ): Promise<DaemonNavigationWorkerResponse> {
    return this.send(`execute:${requestId}`, {
      kind: "execute",
      generation: this.generation,
      requestId,
      request,
    });
  }

  releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    return this.send("release-transient", {
      kind: "release-transient",
      generation: this.generation,
    });
  }

  async drainAndClose(): Promise<void> {
    if (this.exit !== undefined) return;
    await this.send("close", { kind: "close", generation: this.generation });
    await this.exited;
  }

  async terminate(): Promise<void> {
    if (this.exit !== undefined) return;
    this.terminating = true;
    await this.worker.terminate();
    await this.exited;
  }

  private send(
    key: string,
    request: DaemonNavigationWorkerRequest,
  ): Promise<DaemonNavigationWorkerResponse> {
    if (this.exit !== undefined)
      return Promise.reject(new Error("Daemon navigation worker exited"));
    if (this.pending.has(key) || this.completed.has(key)) {
      return Promise.reject(new Error(`Duplicate daemon navigation worker request: ${key}`));
    }
    const response = new Promise<DaemonNavigationWorkerResponse>((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
    });
    this.worker.postMessage(DaemonNavigationWorkerProtocol.request(request));
    return response;
  }

  private receive(value: unknown): void {
    let response: DaemonNavigationWorkerResponse;
    try {
      response = DaemonNavigationWorkerProtocol.response(value);
    } catch (error) {
      this.failCommunication(error);
      return;
    }
    if (response.generation !== this.generation) return;
    const key = NodeDaemonNavigationWorker.responseKey(response);
    if (this.completed.has(key)) {
      this.failCommunication(new Error(`Duplicate daemon navigation worker response: ${key}`));
      return;
    }
    const pending = this.pending.get(key);
    if (pending === undefined) {
      this.failCommunication(new Error(`Uncorrelated daemon navigation worker response: ${key}`));
      return;
    }
    this.pending.delete(key);
    this.completed.add(key);
    if (response.kind === "failed") {
      pending.reject(new Error(`Daemon navigation worker ${response.failureCode} failure`));
      return;
    }
    if (response.kind === "closed") this.closeAcknowledged = true;
    pending.resolve(response);
  }

  private failCommunication(error: unknown): void {
    if (this.exit !== undefined) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.communicationErrorName = failure.name;
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
    void this.worker.terminate();
  }

  private finishExit(): void {
    if (this.exit !== undefined) return;
    const cause = this.communicationErrorName
      ? this.communicationErrorName === "ERR_WORKER_OUT_OF_MEMORY"
        ? "out-of-memory"
        : "error"
      : this.terminating
        ? "terminated"
        : this.closeAcknowledged
          ? "closed"
          : "error";
    this.exit = {
      generation: this.generation,
      cause,
      ...(this.communicationErrorName === undefined
        ? {}
        : { errorName: this.communicationErrorName }),
    };
    const failure = new Error(`Daemon navigation worker exited (${cause})`);
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
    this.resolveExited(this.exit);
  }

  private static responseKey(response: DaemonNavigationWorkerResponse): string {
    if (response.kind === "ready") return "initialize";
    if (response.kind === "result") return `execute:${response.requestId}`;
    if (response.kind === "heap") return "release-transient";
    if (response.kind === "closed") return "close";
    return response.requestId === undefined ? "initialize" : `execute:${response.requestId}`;
  }
}
