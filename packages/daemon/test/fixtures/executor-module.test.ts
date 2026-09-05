import { describe, expect, it } from "vitest";
import type { DaemonExecutorFactory } from "../../src/daemon-executor.js";
import * as executorModule from "./executor-module.js";

describe("generic daemon executor fixture", () => {
  it("exports only the public executor factory", () => {
    expect(Object.keys(executorModule)).toEqual(["createDaemonExecutor"]);
    expect(executorModule.createDaemonExecutor satisfies DaemonExecutorFactory).toBeDefined();
  });

  it("initializes, executes ordered output, and releases deterministically", async () => {
    let resourceSamples = 0;
    const executor = executorModule.createDaemonExecutor({
      stateDirectory: "/state",
      productVersion: "test",
      sampleResources: () => {
        resourceSamples += 1;
      },
    });

    await expect(executor.initialize("files:3")).resolves.toEqual({ fileCount: 3 });
    const result = await executor.execute({
      argv: ["stdout:one", "stderr:two", "exit:7"],
      cwd: "/workspace",
      telemetryEnabled: false,
      executionMode: "warm",
    });
    const records = [];
    for await (const record of result.output.records()) records.push(record);
    expect(records).toEqual([
      { stream: "stdout", bytes: Buffer.from("one") },
      { stream: "stderr", bytes: Buffer.from("two") },
    ]);
    expect(result.exitCode).toBe(7);
    await executor.releaseTransientResources();
    expect(resourceSamples).toBe(1);
  });

  it.each([
    ["initialize", "fail:initialize", "test", "fixture initialize failure"],
    ["execute", "files:1", "test", "fixture execute failure"],
    ["release", "files:1", "fail:release", "fixture release failure"],
  ] as const)("supports deterministic %s failure", async (operation, workspaceRoot, version, error) => {
    const executor = executorModule.createDaemonExecutor({
      stateDirectory: "/state",
      productVersion: version,
      sampleResources: () => undefined,
    });
    if (operation === "initialize") {
      await expect(executor.initialize(workspaceRoot)).rejects.toThrow(error);
      return;
    }
    await executor.initialize(workspaceRoot);
    if (operation === "execute") {
      await expect(
        executor.execute({
          argv: ["fail:execute"],
          cwd: "/workspace",
          telemetryEnabled: false,
          executionMode: "warm",
        }),
      ).rejects.toThrow(error);
      return;
    }
    await expect(executor.releaseTransientResources()).rejects.toThrow(error);
  });
});
