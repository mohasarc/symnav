import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { RunSymnavBinaryResult } from "@symnav/testing";
import { NavigationModeDaemonStatusDecoder } from "../e2e/run-navigation-mode.js";
import { E2eProcessCleanup } from "../helpers/e2e-process-cleanup.js";

export interface InstalledSymnavOptions {
  readonly prefix: string;
  readonly stateDirectory: string;
  readonly workspaceDirectory: string;
  readonly daemon: "cold" | "warm";
}

export class InstalledSymnav {
  private static readonly PACKAGE_NAME = "symnav";

  constructor(private readonly options: InstalledSymnavOptions) {}

  get packageDirectory(): string {
    if (process.platform === "win32") {
      return join(this.options.prefix, "node_modules", InstalledSymnav.PACKAGE_NAME);
    }
    return join(this.options.prefix, "lib", "node_modules", InstalledSymnav.PACKAGE_NAME);
  }

  run(args: readonly string[], environment: NodeJS.ProcessEnv = {}): RunSymnavBinaryResult {
    const cliPath = join(this.packageDirectory, "dist", "cli.js");
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: this.options.workspaceDirectory,
      encoding: "utf8",
      env: { ...this.environment(), ...environment },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  runShim(args: readonly string[]): RunSymnavBinaryResult {
    const isWindows = process.platform === "win32";
    const shimPath = isWindows
      ? join(this.options.prefix, `${InstalledSymnav.PACKAGE_NAME}.cmd`)
      : join(this.options.prefix, "bin", InstalledSymnav.PACKAGE_NAME);
    const result = spawnSync(shimPath, args, {
      cwd: this.options.workspaceDirectory,
      encoding: "utf8",
      env: this.environment(),
      shell: isWindows,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  async stopDaemons(): Promise<void> {
    const status = this.run(["daemon", "status", "--json"]);
    const daemons = NavigationModeDaemonStatusDecoder.decode(JSON.parse(status.stdout) as unknown);
    for (const daemon of daemons) this.run(["--cwd", daemon.workspaceRoot, "daemon", "stop"]);
    await E2eProcessCleanup.terminate(daemons.map((daemon) => daemon.pid));
  }

  private environment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      SYMNAV_STATE_DIR: this.options.stateDirectory,
    };
    delete environment.NODE_PATH;
    delete environment.SYMNAV_DAEMON;
    if (this.options.daemon === "cold") environment.SYMNAV_DAEMON = "0";
    return environment;
  }
}
