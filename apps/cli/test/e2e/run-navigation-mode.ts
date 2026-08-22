import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type E2eDaemonMode = "0" | "1";

interface RunningDaemon {
  readonly workspaceRoot: string;
}

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

  run(): number {
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
      try {
        this.stopValidatedDaemons();
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        testStatus = 1;
      }
      rmSync(this.runRoot, { recursive: true, force: true });
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

  private stopValidatedDaemons(): void {
    const statuses = this.daemonStatus();
    for (const status of statuses) {
      const stopped = spawnSync(
        process.execPath,
        [this.cliBinPath, "--cwd", status.workspaceRoot, "daemon", "stop", "--json"],
        {
          cwd: this.cliRoot,
          encoding: "utf8",
          env: this.environment(),
        },
      );
      if (stopped.status !== 0) {
        throw new Error(
          `Failed to stop daemon for ${status.workspaceRoot}: ${stopped.stderr || stopped.stdout}`,
        );
      }
    }
    const remaining = this.daemonStatus();
    if (remaining.length !== 0) {
      throw new Error(`E2E teardown left ${remaining.length} daemon instances running`);
    }
  }

  private daemonStatus(): readonly RunningDaemon[] {
    const result = spawnSync(process.execPath, [this.cliBinPath, "daemon", "status", "--json"], {
      cwd: this.cliRoot,
      encoding: "utf8",
      env: this.environment(),
    });
    if (result.status !== 0) {
      throw new Error(`Failed to validate E2E daemons: ${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout) as readonly RunningDaemon[];
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
process.exitCode = new NavigationModeRunner(daemonMode).run();
