import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const binPath = join(cliRoot, "dist", "cli.js");

export interface SymnavRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runSymnavOverview(args: readonly string[], cwd: string): SymnavRunResult {
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
