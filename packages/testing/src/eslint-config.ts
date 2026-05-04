import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function loadWorkspaceEslintConfig(): Promise<unknown> {
  const configUrl = pathToFileURL(join(repoRoot, "eslint.config.mjs")).href;
  const mod = (await import(configUrl)) as { default: unknown };
  return mod.default;
}
