import { describe, expect, it } from "vitest";
import type { CliExecutionRequest } from "../command-execution-result.js";
import { NodeDaemonNavigationWorker } from "./daemon-navigation-worker.js";

const request: CliExecutionRequest = {
  argv: ["overview", "input.ts"],
  cwd: "/repo",
  telemetryEnabled: false,
};

describe("NodeDaemonNavigationWorker", () => {
  it("keeps the main thread responsive during blocking initialization and execution", async () => {
    const worker = createWorker("block");
    const initializationTimer = timerTurn();

    await expect(worker.start("/repo")).resolves.toMatchObject({ kind: "ready", fileCount: 1 });
    await expect(initializationTimer).resolves.toBeLessThan(100);

    const executionTimer = timerTurn();
    await expect(worker.execute("request-1", request)).resolves.toMatchObject({
      kind: "result",
      requestId: "request-1",
      result: { exitCode: 0 },
    });
    await expect(executionTimer).resolves.toBeLessThan(100);
    await worker.drainAndClose();
    await expect(worker.exited).resolves.toEqual({ generation: 7, cause: "closed" });
  });

  it("rejects duplicate terminal messages for one request", async () => {
    const worker = createWorker("duplicate");
    await worker.start("/repo");

    await expect(worker.execute("request-1", request)).resolves.toMatchObject({ kind: "result" });
    await expect(worker.exited).resolves.toMatchObject({ generation: 7, cause: "error" });
  });

  it("ignores late responses from a fenced generation", async () => {
    const worker = createWorker("late-generation");

    await expect(worker.start("/repo")).resolves.toMatchObject({ kind: "ready", generation: 7 });
    await worker.drainAndClose();
    await expect(worker.exited).resolves.toEqual({ generation: 7, cause: "closed" });
  });

  it("reports malformed worker communication as an error exit", async () => {
    const worker = createWorker("malformed");

    await expect(worker.start("/repo")).rejects.toThrow(/worker response/i);
    await expect(worker.exited).resolves.toMatchObject({ generation: 7, cause: "error" });
  });

  it("reports controlled forced termination", async () => {
    const worker = createWorker("block-execution");
    await worker.start("/repo");
    void worker.execute("request-1", request).catch(() => undefined);

    await worker.terminate();

    await expect(worker.exited).resolves.toEqual({ generation: 7, cause: "terminated" });
  });
});

function createWorker(mode: string): NodeDaemonNavigationWorker {
  return new NodeDaemonNavigationWorker({
    generation: 7,
    stateDirectory: "/state",
    entryUrl: new URL("../../test/helpers/daemon-navigation-worker-fixture.mjs", import.meta.url),
    workerData: { mode },
  });
}

function timerTurn(): Promise<number> {
  const startedAt = Date.now();
  return new Promise((resolve) => setTimeout(() => resolve(Date.now() - startedAt), 0));
}
