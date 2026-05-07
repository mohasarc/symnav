import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export function fixturePath(name: string): string {
  const path = join(fixturesRoot, name);
  if (!existsSync(path)) {
    throw new Error(`Fixture not found: ${name} (looked in ${fixturesRoot})`);
  }
  return path;
}
