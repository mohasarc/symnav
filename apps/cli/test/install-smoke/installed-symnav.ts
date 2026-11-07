import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { RunSymnavBinaryResult } from "@symnav/testing";

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

  run(args: readonly string[]): RunSymnavBinaryResult {
    const cliPath = join(this.packageDirectory, "dist", "cli.js");
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: this.options.workspaceDirectory,
      encoding: "utf8",
      env: this.environment(),
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
