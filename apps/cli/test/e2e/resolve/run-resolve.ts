import { join } from "node:path";
import { fixturePath, runSymnavBinary } from "@symnav/testing";
import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

export const resolveFixtureRoot = fixturePath("resolve-cases");
export const noSupportedFilesFixtureRoot = fixturePath("no-supported-files-cases");

const snapshotsDirectory = new URL("./__snapshots__/", import.meta.url).pathname;

export function runResolve(
  args: readonly string[],
  fixtureRoot: string = resolveFixtureRoot,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  ensureFixtureGitMarker(fixtureRoot);
  return runSymnavBinary(args, { cwd: fixtureRoot });
}

export function snapshot(name: string): string {
  return join(snapshotsDirectory, name);
}
