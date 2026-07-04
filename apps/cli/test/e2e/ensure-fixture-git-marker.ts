import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

export function ensureFixtureGitMarker(fixtureRoot: string): void {
  const gitPath = join(fixtureRoot, ".git");
  if (existsSync(gitPath)) {
    return;
  }
  const dotGitPath = join(fixtureRoot, "dot-git");
  cpSync(dotGitPath, gitPath, { recursive: true });
}
