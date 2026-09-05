import { describe, expect, it, vi } from "vitest";
import type { DaemonExecutorRequest, DaemonOutputSink } from "@symnav/daemon";
import type {
  DaemonNavigationWorker,
  DaemonNavigationWorkerExit,
} from "./daemon-navigation-worker.js";
import type { DaemonNavigationWorkerResponse } from "./daemon-navigation-worker-protocol.js";
import { DaemonWorkerGenerationManager } from "./daemon-worker-generation-manager.js";
import type {
  DaemonWorkerExitRecovery,
  DaemonWorkerGenerationManagerOptions,
} from "./daemon-worker-generation-manager-contract.js";

describe("DaemonWorkerGenerationManager", () => {
  it("creates generation one and publishes readiness only after its valid ready report", async () => {
    const worker = new ControlledNavigationWorker(1);
    const manager = createManager({ createWorker: () => worker });

    expect(manager.snapshot).toEqual({ generation: 1, ready: false });
    const starting = manager.start();
    expect(worker.operations).toEqual(["start:1"]);
    expect(manager.snapshot).toEqual({ generation: 1, ready: false });

    worker.completeReady(7);

    await expect(starting).resolves.toMatchObject({
      kind: "ready",
      generation: 1,
      fileCount: 7,
    });
    expect(manager.snapshot).toEqual({ generation: 1, ready: true, fileCount: 7 });
    expect(Object.isFrozen(manager.snapshot)).toBe(true);
  });

  it("rejects an invalid startup report without publishing readiness", async () => {
    const worker = new ControlledNavigationWorker(1);
    const manager = createManager({ createWorker: () => worker });
    const starting = manager.start();

    worker.complete({ kind: "closed", generation: 1 });

    await expect(starting).rejects.toThrow("did not become ready");
    expect(manager.snapshot).toEqual({ generation: 1, ready: false });
  });

  it("delegates execution to the ready generation", async () => {
    const worker = new ControlledNavigationWorker(1);
    const manager = createManager({ createWorker: () => worker });
    const output: DaemonOutputSink = { append: vi.fn(async () => undefined) };
    const request: DaemonExecutorRequest = {
      argv: ["--version"],
      cwd: "/workspace",
      telemetryEnabled: false,
      executionMode: "warm",
    };
    const execution = manager.execute("request-1", { commandName: "version", request }, output);
    worker.completeReady(7);
    worker.executionResponse = resultResponse(1, "request-1");

    await expect(execution).resolves.toEqual(resultResponse(1, "request-1"));
    expect(worker.execution).toEqual({
      requestId: "request-1",
      commandName: "version",
      request,
      output,
    });
  });

  it("rejects an uncorrelated worker execution report", async () => {
    const worker = new ControlledNavigationWorker(1);
    const manager = createManager({ createWorker: () => worker });
    const execution = manager.execute(
      "request-1",
      {
        commandName: "version",
        request: {
          argv: ["--version"],
          cwd: "/workspace",
          telemetryEnabled: false,
          executionMode: "warm",
        },
      },
      { append: async () => undefined },
    );
    worker.completeReady(7);
    worker.executionResponse = resultResponse(1, "another-request");

    await expect(execution).rejects.toThrow("uncorrelated result");
  });

  it("coalesces replacement while preserving transition order and diagnostics", async () => {
    const operations: string[] = [];
    const initial = new ControlledNavigationWorker(1, operations);
    const replacement = new ControlledNavigationWorker(2, operations);
    const activeResourceInterruption = vi.fn();
    const onDiagnostic = vi.fn();
    const manager = createManager({
      initialWorker: initial,
      createWorker: (generation) => {
        expect(generation).toBe(2);
        return replacement;
      },
      onActiveResourceInterruption: activeResourceInterruption,
      onDiagnostic,
    });
    const starting = manager.start();
    initial.completeReady(7);
    await starting;
    operations.length = 0;

    const first = manager.replace("hard-pressure");
    const second = manager.replace("hard-pressure");

    expect(first).toBe(second);
    expect(activeResourceInterruption).toHaveBeenCalledOnce();
    expect(activeResourceInterruption).toHaveBeenCalledWith("hard-pressure");
    expect(operations).toEqual(["start:2", "terminate:1"]);
    expect(manager.snapshot).toEqual({ generation: 2, ready: false });

    replacement.completeReady(9);

    await expect(first).resolves.toMatchObject({ kind: "ready", generation: 2, fileCount: 9 });
    expect(manager.snapshot).toEqual({ generation: 2, ready: true, fileCount: 9 });
    expect(onDiagnostic).toHaveBeenCalledWith({
      kind: "worker-replaced",
      cause: "hard-pressure",
      previousWorkerGeneration: 1,
      workerGeneration: 2,
      fileCount: 9,
      discoveryMs: 1,
      indexingMs: 2,
      totalMs: 3,
    });
  });

  it("does not mark active work as resource-interrupted for literal worker exits", async () => {
    const initial = new ControlledNavigationWorker(1);
    const replacement = new ControlledNavigationWorker(2);
    const activeResourceInterruption = vi.fn();
    const manager = createManager({
      initialWorker: initial,
      createWorker: () => replacement,
      onActiveResourceInterruption: activeResourceInterruption,
    });
    const starting = manager.start();
    initial.completeReady(1);
    await starting;

    const replacing = manager.replace("worker-exit");
    replacement.completeReady(2);
    await replacing;

    expect(activeResourceInterruption).not.toHaveBeenCalled();
  });
});

function createManager(
  overrides: Partial<DaemonWorkerGenerationManagerOptions>,
): DaemonWorkerGenerationManager {
  const exitRecovery: DaemonWorkerExitRecovery = {
    recover: vi.fn(async () => undefined),
  };
  return new DaemonWorkerGenerationManager({
    workspaceRoot: "/workspace",
    createWorker: (generation) => new ControlledNavigationWorker(generation),
    exitRecovery,
    onActiveResourceInterruption: vi.fn(),
    onDiagnostic: vi.fn(),
    ...overrides,
  });
}

class ControlledNavigationWorker implements DaemonNavigationWorker {
  readonly exited: Promise<DaemonNavigationWorkerExit>;
  readonly operations: string[] = [];
  execution:
    | {
        readonly requestId: string;
        readonly commandName: Parameters<DaemonNavigationWorker["execute"]>[1];
        readonly request: Parameters<DaemonNavigationWorker["execute"]>[2];
        readonly output: DaemonOutputSink;
      }
    | undefined;
  executionResponse: DaemonNavigationWorkerResponse | undefined;
  private resolveExited!: (exit: DaemonNavigationWorkerExit) => void;
  private resolveReady!: (response: DaemonNavigationWorkerResponse) => void;
  private rejectReady!: (error: Error) => void;
  private readonly ready: Promise<DaemonNavigationWorkerResponse>;

  constructor(
    readonly generation: number,
    private readonly sharedOperations: string[] = [],
  ) {
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  start(workspaceRoot: string): Promise<DaemonNavigationWorkerResponse> {
    this.operations.push(`start:${this.generation}`);
    this.sharedOperations.push(`start:${this.generation}`);
    expect(workspaceRoot).toBe("/workspace");
    return this.ready;
  }

  execute(
    requestId: string,
    commandName: Parameters<DaemonNavigationWorker["execute"]>[1],
    request: Parameters<DaemonNavigationWorker["execute"]>[2],
    output: DaemonOutputSink,
  ): Promise<DaemonNavigationWorkerResponse> {
    this.execution = { requestId, commandName, request, output };
    if (this.executionResponse === undefined) {
      return Promise.reject(new Error("Execution response is unavailable"));
    }
    return Promise.resolve(this.executionResponse);
  }

  releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    return Promise.reject(new Error("Resource response is unavailable"));
  }

  drainAndClose(): Promise<void> {
    this.operations.push(`close:${this.generation}`);
    this.sharedOperations.push(`close:${this.generation}`);
    return Promise.resolve();
  }

  terminate(): Promise<void> {
    this.operations.push(`terminate:${this.generation}`);
    this.sharedOperations.push(`terminate:${this.generation}`);
    return Promise.resolve();
  }

  completeReady(fileCount: number): void {
    this.complete({
      kind: "ready",
      generation: this.generation,
      fileCount,
      refresh: { added: fileCount, changed: 0, removed: 0, unchanged: 0 },
      startupDurations: { discoveryMs: 1, indexingMs: 2, totalMs: 3 },
    });
  }

  complete(response: DaemonNavigationWorkerResponse): void {
    this.resolveReady(response);
  }

  rejectStart(error: Error): void {
    this.rejectReady(error);
  }

  exit(exit: DaemonNavigationWorkerExit): void {
    this.resolveExited(exit);
  }
}

function resultResponse(generation: number, requestId: string): DaemonNavigationWorkerResponse {
  return {
    kind: "result",
    generation,
    requestId,
    result: { exitCode: 0 },
    refresh: { added: 0, changed: 0, removed: 0, unchanged: 7 },
    durations: { freshnessMs: 1, navigationMs: 2, renderMs: 3, outputMs: 4 },
    resources: {
      workerHeapUsedBytes: 10,
      peakWorkerHeapUsedBytes: 20,
      workerHeapLimitBytes: 30,
    },
  };
}
