import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { DaemonClient } from "@symnav/daemon";

class LifecycleExecutor {
  constructor(options) {
    this.options = options;
  }

  async initialize() {
    if (!isMainThread) {
      writeFileSync(join(this.options.stateDirectory, "lifecycle-worker-started"), "started");
      const release = join(this.options.stateDirectory, "lifecycle-worker-release");
      if (process.env.SYMNAV_TEST_STARTING_STOP === "blocked") {
        const waiting = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(release)) Atomics.wait(waiting, 0, 0, 10);
      } else {
        while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return { fileCount: 1 };
  }

  async execute() {
    return { exitCode: 0 };
  }

  async releaseTransientResources() {}
}

class LifecycleFixture {
  static async run() {
    const client = new DaemonClient({
      stateDirectory: process.env.SYMNAV_STATE_DIR,
      productVersion: "0.1.0",
      daemonEnabled: true,
      executorFactory: createDaemonExecutor,
      executorModuleUrl: import.meta.url,
      readinessProbe: { commandName: "version", argv: ["--version"] },
    });
    const result = await client.execute({
      workspaceRoot: process.cwd().replaceAll("\\", "/"),
      cwd: process.cwd(),
      commandName: "version",
      argv: ["--version"],
      telemetryEnabled: false,
    });
    await result.result.output?.dispose();
    process.stdout.write(`${result.mode}\n`);
  }
}

export function createDaemonExecutor(options) {
  return new LifecycleExecutor(options);
}

if (
  isMainThread &&
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
)
  await LifecycleFixture.run();
