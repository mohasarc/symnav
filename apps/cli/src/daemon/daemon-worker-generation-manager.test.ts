import { describe, expect, it, vi } from "vitest";
import type { DaemonOutputSink } from "@symnav/daemon";
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
  private resolveExited!: (exit: DaemonNavigationWorkerExit) => void;
  private resolveReady!: (response: DaemonNavigationWorkerResponse) => void;
  private rejectReady!: (error: Error) => void;
  private readonly ready: Promise<DaemonNavigationWorkerResponse>;

  constructor(readonly generation: number) {
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
    expect(workspaceRoot).toBe("/workspace");
    return this.ready;
  }

  execute(
    _requestId: string,
    _commandName: "version",
    _request: Parameters<DaemonNavigationWorker["execute"]>[2],
    _output: DaemonOutputSink,
  ): Promise<DaemonNavigationWorkerResponse> {
    return Promise.reject(new Error("Execution response is unavailable"));
  }

  releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    return Promise.reject(new Error("Resource response is unavailable"));
  }

  drainAndClose(): Promise<void> {
    this.operations.push(`close:${this.generation}`);
    return Promise.resolve();
  }

  terminate(): Promise<void> {
    this.operations.push(`terminate:${this.generation}`);
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
