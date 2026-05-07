import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default function globalSetup(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const result = spawnSync("pnpm", ["--filter", "symnav", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to build symnav before e2e tests (exit ${result.status})`);
  }
}
