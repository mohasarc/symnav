import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2eProcessCleanup } from "../helpers/e2e-process-cleanup.js";
import { NavigationModeCleanup, type NavigationModeDaemon } from "./navigation-mode-cleanup.js";

type E2eDaemonMode = "0" | "1";

class NavigationModeRunner {
  private readonly cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  private readonly cliBinPath = join(this.cliRoot, "dist", "cli.js");
  private readonly vitestPath = join(
    this.cliRoot,
    "..",
    "..",
    "node_modules",
    "vitest",
    "vitest.mjs",
  );
  private readonly runRoot = mkdtempSync(join(tmpdir(), "symnav-e2e-mode-"));
  private readonly stateDirectory = join(this.runRoot, "state");

  constructor(private readonly daemonMode: E2eDaemonMode) {}

  async run(): Promise<number> {
    let testStatus = 1;
    try {
      const result = spawnSync(
        process.execPath,
        [this.vitestPath, "run", "--reporter=dot", ...this.navigationTestSources()],
        {
          cwd: this.cliRoot,
          env: this.environment(),
          stdio: "inherit",
        },
      );
      testStatus = result.status ?? 1;
    } finally {
      const cleanupOutcome = await this.cleanup(testStatus);
      testStatus = cleanupOutcome.status;
      for (const error of cleanupOutcome.errors) process.stderr.write(`${error}\n`);
    }
    return testStatus;
  }

  private navigationTestSources(): readonly string[] {
    const e2eRoot = join(this.cliRoot, "test", "e2e");
    const excludedDirectories = new Set(["daemon", "telemetry"]);
    const pending = [e2eRoot];
    const sources: string[] = [];
    while (pending.length > 0) {
      const directory = pending.pop() as string;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          const topLevelDirectory = relative(e2eRoot, path).split(/[\\/]/)[0];
          if (!excludedDirectories.has(topLevelDirectory ?? "")) pending.push(path);
        } else if (entry.name.endsWith(".test.ts")) {
          sources.push(path);
        }
      }
    }
    sources.sort();
    return sources;
  }

  private cleanup(
    testStatus: number,
  ): Promise<{ readonly status: number; readonly errors: readonly string[] }> {
    return new NavigationModeCleanup({
      discoverDaemons: () => this.daemonStatus(),
      stop: (daemon) => this.stopDaemon(daemon),
      terminate: (processIds) => E2eProcessCleanup.terminate(processIds),
      validateRemainingDaemons: () => this.validateRemainingDaemons(),
      removeRunRoot: () => E2eProcessCleanup.removeDirectories([this.runRoot]),
    }).run(testStatus);
  }

  private stopDaemon(daemon: NavigationModeDaemon): void {
    const stopped = spawnSync(
      process.execPath,
      [this.cliBinPath, "--cwd", daemon.workspaceRoot, "daemon", "stop", "--json"],
      {
        cwd: this.cliRoot,
        encoding: "utf8",
        env: this.environment(),
      },
    );
    if (stopped.status !== 0) {
      throw new Error(stopped.stderr || stopped.stdout || `exit status ${String(stopped.status)}`);
    }
  }

  private validateRemainingDaemons(): void {
    const remaining = this.daemonStatus();
    if (remaining.length !== 0) {
      throw new Error(`E2E teardown left ${remaining.length} daemon instances running`);
    }
  }

  private daemonStatus(): readonly NavigationModeDaemon[] {
    const result = spawnSync(process.execPath, [this.cliBinPath, "daemon", "status", "--json"], {
      cwd: this.cliRoot,
      encoding: "utf8",
      env: this.environment(),
    });
    if (result.status !== 0) {
      throw new Error(`Failed to validate E2E daemons: ${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout) as readonly NavigationModeDaemon[];
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      SYMNAV_E2E_DAEMON_MODE: this.daemonMode,
      SYMNAV_STATE_DIR: this.stateDirectory,
      SYMNAV_TELEMETRY: "0",
    };
  }
}

const daemonMode = process.argv[2];
if (daemonMode !== "0" && daemonMode !== "1") {
  throw new Error("Expected E2E daemon mode 0 or 1");
}
process.exitCode = await new NavigationModeRunner(daemonMode).run();
