import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonPolicy, type DaemonExecutorRequest } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import { fixturePath } from "@symnav/testing";
import { NodeDaemonNavigationWorker } from "./daemon-navigation-worker.js";

const request: DaemonExecutorRequest = {
  argv: ["overview", "input.ts"],
  cwd: "/repo",
  telemetryEnabled: false,
  executionMode: "warm",
};

describe("NodeDaemonNavigationWorker", () => {
  const executorModuleUrl = "file:///absolute/symnav/daemon-executor.js";

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
        configuration: {
          stateDirectory: "/state",
          productVersion: "1.2.3",
          executorModuleUrl,
          policy: policy.toSerialized(),
        },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
        entryUrl: new URL(
          "../../test/helpers/daemon-navigation-worker-fixture.mjs",
          import.meta.url,
        ),
        workerData: { mode: "block", policyPath },
      });
      await worker.start("/repo");
      expect(JSON.parse(readFileSync(policyPath, "utf8"))).toEqual({
        policy: policy.toSerialized(),
        productVersion: "1.2.3",
        executorModuleUrl,
      });
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
    const response = await worker.execute("request-1", "version", request, {
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

    await expect(
      worker.execute("request-1", "version", request, outputSink()),
    ).resolves.toMatchObject({
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
    const execution = worker.execute("request-1", "version", request, {
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
    void worker.execute("request-1", "version", request, outputSink()).catch(() => undefined);

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

  it("loads the injected executor, rechunks output, preserves diagnostics, and disposes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-injected-worker-"));
    const worker = createInjectedWorker(
      new URL("../../test/helpers/injected-daemon-executor-fixture.mjs", import.meta.url).href,
      directory,
    );
    try {
      await expect(worker.start(fixturePath("overview-cases"))).resolves.toMatchObject({
        kind: "ready",
        fileCount: 37,
        refresh: { added: 2, changed: 3, removed: 5, unchanged: 7 },
        startupDurations: { discoveryMs: 11, indexingMs: 22 },
        diagnostics: { nested: { future: [null, true, "opaque"] } },
      });
      const records: Array<{ sequence: number; stream: string; bytes: Uint8Array }> = [];
      await expect(
        worker.execute("request-1", "version", request, {
          append: async (record) => {
            records.push(record);
          },
        }),
      ).resolves.toMatchObject({
        kind: "result",
        refresh: { added: 0, changed: 1, removed: 0, unchanged: 36 },
        durations: { freshnessMs: 3, navigationMs: 4, renderMs: 5 },
        diagnostics: { nested: { future: [1, "opaque"] } },
      });
      expect(
        records.map(({ sequence, stream, bytes }) => [sequence, stream, bytes.byteLength]),
      ).toEqual([
        [0, "stdout", 65_536],
        [1, "stdout", 4_464],
        [2, "stderr", 2],
      ]);
      expect(readFileSync(join(directory, "executor-events.txt"), "utf8")).toBe("dispose\n");
      await worker.releaseTransientResources();
      await worker.releaseTransientResources();
      expect(readFileSync(join(directory, "executor-events.txt"), "utf8")).toBe(
        "dispose\nrelease\nrelease\n",
      );
      await worker.drainAndClose();
      expect(readFileSync(join(directory, "executor-events.txt"), "utf8")).toBe(
        "dispose\nrelease\nrelease\nrelease\n",
      );
    } finally {
      await worker.terminate();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["invalid scheme", "https://example.test/executor.js", "valid"],
    [
      "missing module",
      new URL("../../test/helpers/missing-executor.mjs", import.meta.url).href,
      "valid",
    ],
    [
      "factory failure",
      new URL("../../test/helpers/injected-daemon-executor-fixture.mjs", import.meta.url).href,
      "factory-throw",
    ],
    [
      "invalid initialization",
      new URL("../../test/helpers/injected-daemon-executor-fixture.mjs", import.meta.url).href,
      "invalid-initialization",
    ],
    [
      "invalid diagnostics",
      new URL("../../test/helpers/injected-daemon-executor-fixture.mjs", import.meta.url).href,
      "invalid-diagnostics",
    ],
    [
      "initialize failure",
      new URL("../../test/helpers/injected-daemon-executor-fixture.mjs", import.meta.url).href,
      "initialize-throw",
    ],
  ])("classifies injected %s as an initialization failure", async (_name, moduleUrl, version) => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-injected-worker-failure-"));
    const worker = createInjectedWorker(moduleUrl, directory, version);
    try {
      await expect(worker.start(fixturePath("overview-cases"))).rejects.toThrow(
        /initialization failure/i,
      );
    } finally {
      await worker.terminate();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing named export", "export const different = true;"],
    ["invalid factory", "export const createDaemonExecutor = 7;"],
  ])("classifies %s as an initialization failure", async (_name, source) => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-injected-worker-module-"));
    const modulePath = join(directory, "executor.mjs");
    writeFileSync(modulePath, source);
    const worker = createInjectedWorker(new URL(`file://${modulePath}`).href, directory);
    try {
      await expect(worker.start(fixturePath("overview-cases"))).rejects.toThrow(
        /initialization failure/i,
      );
    } finally {
      await worker.terminate();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("classifies a CLI executor version mismatch as an initialization failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-injected-worker-version-"));
    const worker = createInjectedWorker(
      new URL("../../dist/daemon-executor.js", import.meta.url).href,
      directory,
      "definitely-not-the-product-version",
    );
    try {
      await expect(worker.start(fixturePath("overview-cases"))).rejects.toThrow(
        /initialization failure/i,
      );
    } finally {
      await worker.terminate();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("proves readiness through the injected CLI version command with legacy cold input", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-injected-worker-readiness-"));
    const workspaceRoot = fixturePath("overview-cases");
    const worker = createInjectedWorker(
      new URL("../../dist/daemon-executor.js", import.meta.url).href,
      directory,
      "0.1.0",
    );
    try {
      await expect(worker.start(workspaceRoot)).resolves.toMatchObject({
        kind: "ready",
        fileCount: 17,
        startupDurations: {
          discoveryMs: 0,
          indexingMs: expect.any(Number),
          totalMs: expect.any(Number),
        },
      });
      const records: Uint8Array[] = [];
      await expect(
        worker.execute(
          "readiness-probe",
          "version",
          {
            argv: ["--version"],
            cwd: workspaceRoot,
            telemetryEnabled: false,
            executionMode: "cold",
          },
          {
            append: async (record) => {
              records.push(record.bytes);
            },
          },
        ),
      ).resolves.toMatchObject({
        kind: "result",
        result: { exitCode: 0 },
        durations: {
          freshnessMs: 0,
          navigationMs: 0,
          renderMs: 0,
          outputMs: expect.any(Number),
        },
      });
      expect(Buffer.concat(records).toString("utf8")).toBe("0.1.0\n");
      await worker.drainAndClose();
    } finally {
      await worker.terminate();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createInjectedWorker(
  executorModuleUrl: string,
  stateDirectory: string,
  productVersion = "valid",
): NodeDaemonNavigationWorker {
  const policy = DaemonPolicy.fromSystemMemory({ totalBytes: 512 * 1024 * 1024 });
  return new NodeDaemonNavigationWorker({
    generation: 11,
    configuration: {
      stateDirectory,
      productVersion,
      executorModuleUrl,
      policy: policy.toSerialized(),
    },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
    entryUrl: new URL("../../dist/daemon/daemon-navigation-worker-entry.js", import.meta.url),
  });
}

function createWorker(mode: string, maxOldGenerationSizeMb = 128): NodeDaemonNavigationWorker {
  const policy = DaemonPolicy.fromSystemMemory({ totalBytes: 512 * 1024 * 1024 });
  return new NodeDaemonNavigationWorker({
    generation: 7,
    configuration: {
      stateDirectory: "/state",
      productVersion: "1.2.3",
      executorModuleUrl: "file:///absolute/symnav/daemon-executor.js",
      policy: policy.toSerialized(),
    },
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
