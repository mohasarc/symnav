import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliBinPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "cli",
  "dist",
  "cli.js",
);

export interface RunSymnavBinaryResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunSymnavBinaryOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export function runSymnavBinary(
  args: readonly string[],
  opts: RunSymnavBinaryOptions,
): RunSymnavBinaryResult {
  const result = spawnSync(process.execPath, [cliBinPath, ...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    env: { ...process.env, SYMNAV_TELEMETRY: "0", ...opts.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
