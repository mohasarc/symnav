import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonExecutorModuleLoader } from "./daemon-executor.js";

describe("DaemonExecutorModuleLoader", () => {
  const directories: string[] = [];
  const options = {
    stateDirectory: "/state",
    productVersion: "1.2.3",
    sampleResources: () => undefined,
  } as const;

  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  it("loads and validates the named executor factory", async () => {
    const executor = await DaemonExecutorModuleLoader.load(
      moduleUrl(directories, validModule()),
      options,
    );

    await expect(executor.initialize("/repo")).resolves.toEqual({
      fileCount: 2,
      diagnostics: { nested: { values: [null, true, 1, "opaque"] } },
    });
    const result = await executor.execute({
      argv: ["--version"],
      cwd: "/repo",
      telemetryEnabled: false,
      executionMode: "warm",
    });
    const records = [];
    for await (const record of result.output.records()) records.push(record);
    expect(records).toEqual([{ stream: "stdout", bytes: new Uint8Array([1, 2, 3]) }]);
    await result.output.dispose();
    await executor.releaseTransientResources();
  });

  it("loads executor modules from percent-encoded paths", async () => {
    await expect(
      DaemonExecutorModuleLoader.load(
        moduleUrl(directories, validModule(), "symnav-daemon-loader-~"),
        options,
      ),
    ).resolves.toBeDefined();
  });

  it.each(["https://example.test/executor.js", "data:text/javascript,export default 1"])(
    "rejects the executor module scheme for %s",
    async (moduleUrl) => {
      await expect(DaemonExecutorModuleLoader.load(moduleUrl, options)).rejects.toThrow(
        /file URL/i,
      );
    },
  );

  it("rejects a missing executor module", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-daemon-loader-"));
    directories.push(directory);

    await expect(
      DaemonExecutorModuleLoader.load(pathToFileURL(join(directory, "missing.mjs")).href, options),
    ).rejects.toThrow();
  });

  it.each([
    ["missing named export", "export const different = () => ({});"],
    ["invalid factory", "export const createDaemonExecutor = 7;"],
    ["invalid executor", "export const createDaemonExecutor = () => ({});"],
  ])("rejects %s", async (_name, source) => {
    await expect(
      DaemonExecutorModuleLoader.load(moduleUrl(directories, source), options),
    ).rejects.toThrow(/executor/i);
  });

  it.each([
    ["initialization result", "return { fileCount: -1 };"],
    ["initialization diagnostics", "return { fileCount: 1, diagnostics: { bad: undefined } };"],
  ])("rejects an invalid %s", async (_name, initialization) => {
    const executor = await DaemonExecutorModuleLoader.load(
      moduleUrl(directories, validModule({ initialization })),
      options,
    );

    await expect(executor.initialize("/repo")).rejects.toThrow(/initialization result/i);
  });

  it("rejects an invalid execution result", async () => {
    const executor = await DaemonExecutorModuleLoader.load(
      moduleUrl(directories, validModule({ execution: "return { exitCode: -1 };" })),
      options,
    );

    await expect(
      executor.execute({
        argv: [],
        cwd: "/repo",
        telemetryEnabled: false,
        executionMode: "warm",
      }),
    ).rejects.toThrow(/execution result/i);
  });
});

function moduleUrl(
  directories: string[],
  source: string,
  directoryPrefix = "symnav-daemon-loader-",
): string {
  const directory = mkdtempSync(join(tmpdir(), directoryPrefix));
  directories.push(directory);
  const path = join(directory, "executor.mjs");
  writeFileSync(path, source);
  return pathToFileURL(path).href;
}

function validModule(overrides: { initialization?: string; execution?: string } = {}): string {
  return `
    export function createDaemonExecutor() {
      return {
        async initialize() {
          ${overrides.initialization ?? 'return { fileCount: 2, diagnostics: { nested: { values: [null, true, 1, "opaque"] } } };'}
        },
        async execute() {
          ${overrides.execution ?? "return { exitCode: 0, output: { async *records() { yield { stream: 'stdout', bytes: new Uint8Array([1, 2, 3]) }; }, async dispose() {} }, diagnostics: { future: ['value'] } };"}
        },
        async releaseTransientResources() {}
      };
    }
  `;
}
