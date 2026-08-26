import { Worker } from "node:worker_threads";
import type { CliExecutionRequest, CommandOutputRecord } from "../command-execution-result.js";
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
  execute(
    requestId: string,
    request: CliExecutionRequest,
    output: { append(record: CommandOutputRecord): Promise<void> },
  ): Promise<DaemonNavigationWorkerResponse>;
  releaseTransientResources(): Promise<DaemonNavigationWorkerResponse>;
  drainAndClose(): Promise<void>;
  terminate(): Promise<void>;
}

export interface DaemonNavigationWorkerConfiguration {
  readonly stateDirectory: string;
}

export interface NodeDaemonNavigationWorkerOptions {
  readonly generation: number;
  readonly configuration: DaemonNavigationWorkerConfiguration;
  readonly resourceLimits: {
    readonly maxOldGenerationSizeMb: number;
  };
  readonly entryUrl?: URL;
  readonly workerData?: Readonly<Record<string, unknown>>;
}

interface PendingWorkerResponse {
  readonly resolve: (response: DaemonNavigationWorkerResponse) => void;
  readonly reject: (error: Error) => void;
  readonly appendOutput: (record: CommandOutputRecord) => Promise<void>;
  nextSequence: number;
  chunkInFlight: boolean;
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
  private communicationFailure: Error | undefined;
  private communicationFailureCode: string | undefined;
  private releaseSequence = 0;

  constructor(options: NodeDaemonNavigationWorkerOptions) {
    this.generation = options.generation;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.worker = new Worker(
      options.entryUrl ?? new URL("./daemon-navigation-worker-entry.js", import.meta.url),
      {
        workerData: {
          stateDirectory: options.configuration.stateDirectory,
          generation: options.generation,
          ...options.workerData,
        },
        resourceLimits: options.resourceLimits,
      },
    );
    this.worker.on("message", (value: unknown) => void this.receive(value));
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
    output: { append(record: CommandOutputRecord): Promise<void> },
  ): Promise<DaemonNavigationWorkerResponse> {
    return this.send(
      `execute:${requestId}`,
      {
        kind: "execute",
        generation: this.generation,
        requestId,
        request,
      },
      output.append.bind(output),
    );
  }

  releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    const operationId = `${this.generation}:${this.releaseSequence}`;
    this.releaseSequence += 1;
    return this.send(`release-transient:${operationId}`, {
      kind: "release-transient",
      generation: this.generation,
      operationId,
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
    appendOutput: ((record: CommandOutputRecord) => Promise<void>) | undefined = undefined,
  ): Promise<DaemonNavigationWorkerResponse> {
    if (this.exit !== undefined)
      return Promise.reject(new Error("Daemon navigation worker exited"));
    if (this.pending.has(key) || this.completed.has(key)) {
      return Promise.reject(new Error(`Duplicate daemon navigation worker request: ${key}`));
    }
    const response = new Promise<DaemonNavigationWorkerResponse>((resolve, reject) => {
      this.pending.set(key, {
        resolve,
        reject,
        appendOutput:
          appendOutput ?? (() => Promise.reject(new Error("Worker output sink is unavailable"))),
        nextSequence: 0,
        chunkInFlight: false,
      });
    });
    this.worker.postMessage(DaemonNavigationWorkerProtocol.request(request));
    return response;
  }

  private async receive(value: unknown): Promise<void> {
    let response: DaemonNavigationWorkerResponse;
    try {
      response = DaemonNavigationWorkerProtocol.response(value);
    } catch (error) {
      this.failCommunication(error);
      return;
    }
    if (response.generation !== this.generation) return;
    if (response.kind === "output-chunk") {
      await this.receiveOutputChunk(response);
      return;
    }
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

  private async receiveOutputChunk(
    response: Extract<DaemonNavigationWorkerResponse, { kind: "output-chunk" }>,
  ): Promise<void> {
    const key = `execute:${response.requestId}`;
    const pending = this.pending.get(key);
    if (
      pending === undefined ||
      pending.chunkInFlight ||
      response.sequence !== pending.nextSequence
    ) {
      this.failCommunication(new Error(`Unexpected daemon navigation worker output: ${key}`));
      return;
    }
    pending.chunkInFlight = true;
    try {
      const record: CommandOutputRecord = {
        sequence: response.sequence,
        stream: response.stream,
        bytes: response.bytes,
      };
      await pending.appendOutput(record);
      pending.nextSequence += 1;
      pending.chunkInFlight = false;
      const acknowledgement: DaemonNavigationWorkerRequest = {
        kind: "output-ack",
        generation: this.generation,
        requestId: response.requestId,
        sequence: response.sequence,
      };
      this.worker.postMessage(DaemonNavigationWorkerProtocol.request(acknowledgement));
    } catch (error) {
      this.failCommunication(error);
    }
  }

  private failCommunication(error: unknown): void {
    if (this.exit !== undefined) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.communicationFailure = failure;
    this.communicationFailureCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    void this.worker.terminate();
  }

  private finishExit(): void {
    if (this.exit !== undefined) return;
    const communicationErrorName = this.communicationFailure?.name;
    const communicationFailureIdentity = this.communicationFailureCode ?? communicationErrorName;
    const cause = communicationFailureIdentity
      ? communicationFailureIdentity === "ERR_WORKER_OUT_OF_MEMORY"
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
      ...(communicationFailureIdentity === undefined
        ? {}
        : { errorName: communicationFailureIdentity }),
    };
    const failure = new DaemonNavigationWorkerExitedError(
      this.exit,
      this.communicationFailure?.message,
    );
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
    this.resolveExited(this.exit);
  }

  private static responseKey(response: DaemonNavigationWorkerResponse): string {
    if (response.kind === "ready") return "initialize";
    if (response.kind === "result") return `execute:${response.requestId}`;
    if (response.kind === "heap") return `release-transient:${response.operationId}`;
    if (response.kind === "closed") return "close";
    if (response.kind === "failed" && response.operationId !== undefined) {
      return `release-transient:${response.operationId}`;
    }
    return response.requestId === undefined ? "initialize" : `execute:${response.requestId}`;
  }
}
