import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixturePath } from "@symnav/testing";

/**
 * Materialize a synthetic `.git/HEAD` inside the `overview-cases` fixture so
 * `createWorkspace` recognizes it as a git workspace at e2e test time.
 *
 * Committing a real `.git/` directory inside the fixture would cause the host
 * repository to treat it as a submodule. Instead, e2e tests construct the
 * marker on demand and remove it on teardown. The host `.gitignore` lists this
 * path so an interrupted test run never accidentally commits the artifact.
 */
export function overviewCasesRoot(): string {
  return fixturePath("overview-cases");
}

export function createOverviewCasesGitMarker(): void {
  const root = overviewCasesRoot();
  const gitDir = join(root, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
}

export function removeOverviewCasesGitMarker(): void {
  const root = overviewCasesRoot();
  rmSync(join(root, ".git"), { recursive: true, force: true });
}
