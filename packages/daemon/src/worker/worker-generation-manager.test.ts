import { describe, expect, it, vi } from "vitest";
import type { DaemonExecutorRequest, DaemonOutputSink } from "@symnav/daemon";
import type { DaemonNavigationWorker, DaemonNavigationWorkerExit } from "./navigation-worker.js";
import { DaemonNavigationWorkerExitedError } from "./navigation-worker.js";
import type { DaemonNavigationWorkerResponse } from "./worker-protocol.js";
import type {
  DaemonWorkerExitRecovery,
  DaemonWorkerGenerationManagerOptions,
} from "./worker-generation-manager.js";
import { DaemonWorkerGenerationManager } from "./worker-generation-manager.js";

describe("DaemonWorkerGenerationManager", () => {
  it("keeps protocol initialization distinct from externally activated readiness", async () => {
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
    expect(manager.snapshot).toEqual({ generation: 1, ready: false, fileCount: 7 });
    manager.activateReadiness();
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
    manager.activateReadiness();
    operations.length = 0;

    const first = manager.replace("hard-pressure");
    const second = manager.replace("hard-pressure");

    expect(first).toBe(second);
    expect(activeResourceInterruption).toHaveBeenCalledOnce();
    expect(activeResourceInterruption).toHaveBeenCalledWith("hard-pressure");
    expect(operations).toEqual(["start:2", "terminate:1"]);
    expect(manager.snapshot).toEqual({ generation: 2, ready: false, fileCount: 7 });

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

  it.each(["out-of-memory", "shed-failure"] as const)(
    "marks active work as resource-interrupted for %s replacement",
    async (cause) => {
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

      const replacing = manager.replace(cause);
      replacement.completeReady(2);
      await replacing;

      expect(activeResourceInterruption).toHaveBeenCalledOnce();
      expect(activeResourceInterruption).toHaveBeenCalledWith(cause);
    },
  );

  it("recovers only exits from the current generation", async () => {
    const initial = new ControlledNavigationWorker(1);
    const replacement = new ControlledNavigationWorker(2);
    const recover = vi.fn(async () => undefined);
    const manager = createManager({
      initialWorker: initial,
      createWorker: () => replacement,
      exitRecovery: { recover },
    });
    const starting = manager.start();
    initial.completeReady(1);
    await starting;
    const replacing = manager.replace("hard-pressure");
    replacement.completeReady(2);
    await replacing;

    initial.exit({ generation: 1, cause: "error", errorName: "LateExit" });
    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();

    replacement.exit({ generation: 2, cause: "error", errorName: "CurrentExit" });
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    expect(recover).toHaveBeenCalledWith({
      generation: 2,
      cause: "error",
      errorName: "CurrentExit",
    });
  });

  it("returns replacement readiness when the initial worker exits during startup", async () => {
    const initial = new ControlledNavigationWorker(1);
    const replacement = new ControlledNavigationWorker(2);
    let manager: DaemonWorkerGenerationManager;
    const recover = vi.fn(async (exit: DaemonNavigationWorkerExit) => {
      const cause = exit.cause === "out-of-memory" ? "out-of-memory" : "worker-exit";
      await manager.replace(cause);
    });
    manager = createManager({
      initialWorker: initial,
      createWorker: () => replacement,
      exitRecovery: { recover },
    });
    const starting = manager.start();
    const exit: DaemonNavigationWorkerExit = {
      generation: 1,
      cause: "out-of-memory",
      errorName: "WorkerOom",
    };

    initial.rejectStart(new DaemonNavigationWorkerExitedError(exit));
    initial.exit(exit);
    await vi.waitFor(() => expect(replacement.operations).toContain("start:2"));
    replacement.completeReady(11);

    await expect(starting).resolves.toMatchObject({
      kind: "ready",
      generation: 2,
      fileCount: 11,
    });
    expect(manager.snapshot).toEqual({ generation: 2, ready: false, fileCount: 11 });
  });

  it("releases transient resources through the current generation", async () => {
    const worker = new ControlledNavigationWorker(1);
    const onDiagnostic = vi.fn();
    const manager = createManager({ initialWorker: worker, onDiagnostic });
    const starting = manager.start();
    worker.completeReady(1);
    await starting;
    worker.resourceResponse = {
      kind: "heap",
      generation: 1,
      operationId: "release-1",
      usedHeapBytes: 12,
      heapLimitBytes: 24,
    };

    await expect(manager.releaseTransientResources()).resolves.toEqual(worker.resourceResponse);
    expect(worker.operations).toContain("release:1");
    expect(onDiagnostic).toHaveBeenCalledWith({
      kind: "resources-released",
      workerGeneration: 1,
      workerHeapUsedBytes: 12,
      workerHeapLimitBytes: 24,
    });
  });

  it("rejects an invalid transient resource report", async () => {
    const worker = new ControlledNavigationWorker(1);
    const manager = createManager({ initialWorker: worker });
    const starting = manager.start();
    worker.completeReady(1);
    await starting;
    worker.resourceResponse = { kind: "closed", generation: 1 };

    await expect(manager.releaseTransientResources()).rejects.toThrow("did not report heap usage");
  });

  it("shares idempotent drain-close and terminate operations", async () => {
    const worker = new ControlledNavigationWorker(1);
    const manager = createManager({ initialWorker: worker });
    const closeGate = deferredVoid();
    const terminateGate = deferredVoid();
    worker.closeOperation = closeGate.promise;
    worker.terminateOperation = terminateGate.promise;

    const firstClose = manager.close();
    const secondClose = manager.close();
    const firstTerminate = manager.terminate();
    const secondTerminate = manager.terminate();

    expect(firstClose).toBe(secondClose);
    expect(firstTerminate).toBe(secondTerminate);
    expect(worker.operations.filter((operation) => operation === "close:1")).toHaveLength(1);
    expect(worker.operations.filter((operation) => operation === "terminate:1")).toHaveLength(1);
    closeGate.resolve();
    terminateGate.resolve();
    await expect(Promise.all([firstClose, firstTerminate])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("retains worker close and termination failures across repeated calls", async () => {
    const worker = new ControlledNavigationWorker(1);
    const manager = createManager({ initialWorker: worker });
    const closeFailure = deferredFailure();
    const terminateFailure = deferredFailure();
    worker.closeOperation = closeFailure.promise;
    worker.terminateOperation = terminateFailure.promise;

    const close = manager.close();
    const terminate = manager.terminate();
    closeFailure.reject(new Error("close failed"));
    terminateFailure.reject(new Error("terminate failed"));

    await expect(close).rejects.toThrow("close failed");
    await expect(terminate).rejects.toThrow("terminate failed");
    expect(manager.close()).toBe(close);
    expect(manager.terminate()).toBe(terminate);
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
  resourceResponse: DaemonNavigationWorkerResponse | undefined;
  closeOperation: Promise<void> = Promise.resolve();
  terminateOperation: Promise<void> = Promise.resolve();
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
    this.operations.push(`release:${this.generation}`);
    if (this.resourceResponse === undefined) {
      return Promise.reject(new Error("Resource response is unavailable"));
    }
    return Promise.resolve(this.resourceResponse);
  }

  drainAndClose(): Promise<void> {
    this.operations.push(`close:${this.generation}`);
    this.sharedOperations.push(`close:${this.generation}`);
    return this.closeOperation;
  }

  terminate(): Promise<void> {
    this.operations.push(`terminate:${this.generation}`);
    this.sharedOperations.push(`terminate:${this.generation}`);
    return this.terminateOperation;
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

function deferredVoid(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function deferredFailure(): {
  readonly promise: Promise<void>;
  readonly reject: (error: Error) => void;
} {
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  return { promise, reject };
}
