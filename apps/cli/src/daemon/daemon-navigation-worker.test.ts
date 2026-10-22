import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import type { CliExecutionRequest } from "../command-execution-result.js";
import { NodeDaemonNavigationWorker } from "./daemon-navigation-worker.js";

const request: CliExecutionRequest = {
  argv: ["overview", "input.ts"],
  cwd: "/repo",
  telemetryEnabled: false,
};

describe("NodeDaemonNavigationWorker", () => {
  it("passes the exact complete policy to worker data", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-worker-policy-"));
    const policyPath = join(directory, "policy.json");
    const policy = DaemonPolicyTestFactory.withOverrides(
      DaemonPolicy.fromSystemMemory({ totalBytes: 1024 * 1024 * 1024 }),
      {
        resources: {
          hardProcessRssBytes: 912,
          softProcessRssBytes: 911,
          resumeProcessRssBytes: 910,
          workerHeapSampleIntervalMs: 913,
        },
      },
    );
    try {
      const worker = new NodeDaemonNavigationWorker({
        generation: 7,
        configuration: { stateDirectory: "/state", policy: policy.toSerialized() },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
        entryUrl: new URL(
          "../../test/helpers/daemon-navigation-worker-fixture.mjs",
          import.meta.url,
        ),
        workerData: { mode: "block", policyPath },
      });
      await worker.start("/repo");
      expect(JSON.parse(readFileSync(policyPath, "utf8"))).toEqual(policy.toSerialized());
      await worker.drainAndClose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the main thread responsive during blocking initialization and execution", async () => {
    const worker = createWorker("block");
    const initializationTimer = timerTurn();

    await expect(worker.start("/repo")).resolves.toMatchObject({ kind: "ready", fileCount: 1 });
    await expect(initializationTimer).resolves.toBeLessThan(100);

    const executionTimer = timerTurn();
    const chunks: Uint8Array[] = [];
    const response = await worker.execute("request-1", request, {
      append: (record) => {
        chunks.push(record.bytes);
        return Promise.resolve();
      },
    });
    expect(response).toMatchObject({
      kind: "result",
      requestId: "request-1",
      result: { exitCode: 0 },
    });
    expect(Buffer.concat(chunks).toString()).toBe("worker output\n");
    await expect(executionTimer).resolves.toBeLessThan(100);
    await worker.drainAndClose();
    await expect(worker.exited).resolves.toEqual({ generation: 7, cause: "closed" });
  });

  it("rejects duplicate terminal messages for one request", async () => {
    const worker = createWorker("duplicate");
    await worker.start("/repo");

    await expect(worker.execute("request-1", request, outputSink())).resolves.toMatchObject({
      kind: "result",
    });
    await expect(worker.exited).resolves.toMatchObject({ generation: 7, cause: "error" });
  });

  it("acknowledges a worker chunk only after the resumable owner appends it", async () => {
    const worker = createWorker("block");
    await worker.start("/repo");
    let releaseAppend!: () => void;
    const appendAllowed = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appended = false;
    const execution = worker.execute("request-1", request, {
      append: async () => {
        appended = true;
        await appendAllowed;
      },
    });
    while (!appended) await new Promise((resolve) => setTimeout(resolve, 1));

    let completed = false;
    void execution.then(() => {
      completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(completed).toBe(false);

    releaseAppend();
    await expect(execution).resolves.toMatchObject({ kind: "result", requestId: "request-1" });
    await worker.drainAndClose();
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
    void worker.execute("request-1", request, outputSink()).catch(() => undefined);

    await worker.terminate();

    await expect(worker.exited).resolves.toEqual({ generation: 7, cause: "terminated" });
  });

  it("applies the configured old-generation limit to the navigation worker only", async () => {
    const worker = createWorker("heap-limit", 32);
    await worker.start("/repo");

    const response = await worker.releaseTransientResources();
    if (response.kind !== "heap") throw new Error("Expected worker heap report");
    expect(response.generation).toBe(7);
    expect(response.heapLimitBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(response.heapLimitBytes).toBeLessThan(96 * 1024 * 1024);
    await worker.drainAndClose();
  });

  it("releases transient resources repeatedly within one worker generation", async () => {
    const worker = createWorker("heap-limit", 32);
    await worker.start("/repo");

    await expect(worker.releaseTransientResources()).resolves.toMatchObject({
      kind: "heap",
      generation: 7,
    });
    await expect(worker.releaseTransientResources()).resolves.toMatchObject({
      kind: "heap",
      generation: 7,
    });
    await worker.drainAndClose();
  });

  it("settles a failed transient release and permits a later release", async () => {
    const worker = createWorker("release-failure-once");
    await worker.start("/repo");

    await expect(worker.releaseTransientResources()).rejects.toThrow(/resource failure/i);
    await expect(worker.releaseTransientResources()).resolves.toMatchObject({
      kind: "heap",
      generation: 7,
    });
    await worker.drainAndClose();
  });
});

function createWorker(mode: string, maxOldGenerationSizeMb = 128): NodeDaemonNavigationWorker {
  const policy = DaemonPolicy.fromSystemMemory({ totalBytes: 512 * 1024 * 1024 });
  return new NodeDaemonNavigationWorker({
    generation: 7,
    configuration: { stateDirectory: "/state", policy: policy.toSerialized() },
    resourceLimits: { maxOldGenerationSizeMb },
    entryUrl: new URL("../../test/helpers/daemon-navigation-worker-fixture.mjs", import.meta.url),
    workerData: { mode },
  });
}

function outputSink() {
  return { append: () => Promise.resolve() };
}

function timerTurn(): Promise<number> {
  const startedAt = Date.now();
  return new Promise((resolve) => setTimeout(() => resolve(Date.now() - startedAt), 0));
}
