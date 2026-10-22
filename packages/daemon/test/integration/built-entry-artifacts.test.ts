import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DaemonPolicy, DaemonPolicyCodec } from "../../src/daemon-policy.js";
import { NodeDaemonNavigationWorker } from "../../dist/worker/navigation-worker.js";

describe("built daemon entry artifacts", () => {
  const packageDirectory = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const executorModuleUrl = pathToFileURL(
    join(packageDirectory, "test", "fixtures", "executor-module.mjs"),
  ).href;
  const policy = DaemonPolicy.fromSystemMemory({ totalBytes: 512 * 1024 * 1024 });

  it("runs the package-relative worker entry with an absolute executor file URL", async () => {
    const worker = new NodeDaemonNavigationWorker({
      generation: 1,
      configuration: {
        stateDirectory: join(packageDirectory, "test"),
        productVersion: "test",
        executorModuleUrl,
        policy: DaemonPolicyCodec.serialize(policy),
      },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    try {
      await expect(worker.start("files:3")).resolves.toMatchObject({
        kind: "ready",
        fileCount: 3,
      });
      const output: string[] = [];
      await expect(
        worker.execute(
          "request",
          "version",
          {
            argv: ["stdout:one", "stderr:two", "exit:7"],
            cwd: packageDirectory,
            telemetryEnabled: false,
            executionMode: "warm",
          },
          {
            append: async (record) => {
              output.push(`${record.stream}:${Buffer.from(record.bytes).toString()}`);
            },
          },
        ),
      ).resolves.toMatchObject({ kind: "result", result: { exitCode: 7 } });
      expect(output).toEqual(["stdout:one", "stderr:two"]);
      await worker.releaseTransientResources();
      await worker.drainAndClose();
    } finally {
      await worker.terminate();
    }
  });

  it.each([
    [
      "missing module",
      pathToFileURL(join(packageDirectory, "test", "fixtures", "missing.mjs")).href,
    ],
    ["missing export", pathToFileURL(join(packageDirectory, "package.json")).href],
  ])("retains %s initialization failure", async (_scenario, moduleUrl) => {
    const worker = new NodeDaemonNavigationWorker({
      generation: 1,
      configuration: {
        stateDirectory: join(packageDirectory, "test"),
        productVersion: "test",
        executorModuleUrl: moduleUrl,
        policy: DaemonPolicyCodec.serialize(policy),
      },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    try {
      await expect(worker.start("files:1")).rejects.toThrow(/initialization failure/i);
    } finally {
      await worker.terminate();
    }
  });
});
