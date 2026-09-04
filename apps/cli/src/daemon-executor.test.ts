import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSession } from "@symnav/core";
import { fixturePath } from "@symnav/testing";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { createDaemonExecutor, daemonExecutorModuleUrl } from "./daemon-executor.js";

describe("createDaemonExecutor", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  it("publishes its absolute file module URL", () => {
    const moduleUrl = daemonExecutorModuleUrl();

    expect(new URL(moduleUrl).protocol).toBe("file:");
    expect(isAbsolute(fileURLToPath(moduleUrl))).toBe(true);
  });

  it("constructs one retained session and full-prepares initialization once", async () => {
    const stateDirectory = temporaryDirectory(temporaryDirectories);
    const prepare = vi.spyOn(WorkspaceSession.prototype, "prepare");
    const executor = await createDaemonExecutor({
      stateDirectory,
      productVersion: "0.1.0",
      sampleResources: () => undefined,
    });

    const first = await executor.initialize(fixturePath("trivial-project"));
    const second = await executor.initialize(fixturePath("trivial-project"));

    expect(prepare).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
    expect(first.fileCount).toBeGreaterThan(0);
    expect(first.diagnostics).toMatchObject({
      refresh: {
        added: expect.any(Number),
        changed: expect.any(Number),
        removed: expect.any(Number),
        unchanged: expect.any(Number),
      },
      durations: {
        discoveryMs: 0,
        indexingMs: expect.any(Number),
      },
    });
  });

  it.each(["cold", "fallback"] as const)(
    "executes %s requests before initialization",
    async (executionMode) => {
      const stateDirectory = temporaryDirectory(temporaryDirectories);
      const executor = await createDaemonExecutor({
        stateDirectory,
        productVersion: "0.1.0",
        sampleResources: () => undefined,
      });

      const result = await executor.execute({
        argv: ["--version"],
        cwd: fixturePath("trivial-project"),
        telemetryEnabled: false,
        executionMode,
      });

      expect(result.exitCode).toBe(0);
      expect(await outputText(result.output)).toBe("0.1.0\n");
      await result.output.dispose();
    },
  );

  it("reparses warm argv and stays usable after repeated release", async () => {
    const stateDirectory = temporaryDirectory(temporaryDirectories);
    const release = vi.spyOn(WorkspaceSession.prototype, "releaseTransientResources");
    const executor = await createDaemonExecutor({
      stateDirectory,
      productVersion: "0.1.0",
      sampleResources: () => undefined,
    });
    const workspaceRoot = fixturePath("trivial-project");
    await executor.initialize(workspaceRoot);

    const overview = await executor.execute({
      argv: ["overview", "src/index.ts"],
      cwd: workspaceRoot,
      telemetryEnabled: false,
      executionMode: "warm",
    });
    await executor.releaseTransientResources();
    await executor.releaseTransientResources();
    const version = await executor.execute({
      argv: ["--version"],
      cwd: workspaceRoot,
      telemetryEnabled: false,
      executionMode: "warm",
    });

    expect(await outputText(overview.output)).toContain("trivial-project/src/index.ts");
    expect(await outputText(version.output)).toBe("0.1.0\n");
    expect(release).toHaveBeenCalledTimes(2);
    await overview.output.dispose();
    await version.output.dispose();
  });

  it("exposes ordered stream bytes and disposes the owned output once", async () => {
    const stateDirectory = temporaryDirectory(temporaryDirectories);
    const executor = await createDaemonExecutor({
      stateDirectory,
      productVersion: "0.1.0",
      sampleResources: () => undefined,
    });
    const result = await executor.execute({
      argv: [],
      cwd: fixturePath("trivial-project"),
      telemetryEnabled: false,
      executionMode: "warm",
    });

    const records = [];
    for await (const record of result.output.records()) records.push(record);

    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => Object.keys(record).sort().join(",") === "bytes,stream")).toBe(
      true,
    );
    await result.output.dispose();
    await result.output.dispose();
  });

  it("requests an explicit resource sample after a synchronous command phase", async () => {
    const stateDirectory = temporaryDirectory(temporaryDirectories);
    const sampleResources = vi.fn();
    const executor = await createDaemonExecutor({
      stateDirectory,
      productVersion: "0.1.0",
      sampleResources,
    });

    const result = await executor.execute({
      argv: ["overview", "src/index.ts"],
      cwd: fixturePath("trivial-project"),
      telemetryEnabled: false,
      executionMode: "warm",
    });

    expect(sampleResources).toHaveBeenCalledOnce();
    await result.output.dispose();
  });
});

function temporaryDirectory(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-daemon-executor-"));
  directories.push(directory);
  return directory;
}

async function outputText(output: {
  records(): AsyncIterable<{ readonly bytes: Uint8Array }>;
}): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const record of output.records()) chunks.push(record.bytes);
  return Buffer.concat(chunks).toString();
}
