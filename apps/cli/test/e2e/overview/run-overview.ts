import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixturePath, runSymnavBinary } from "@symnav/testing";
import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

export const overviewFixtureRoot = fixturePath("overview-cases");

const snapshotsDirectory = fileURLToPath(new URL("./__snapshots__/", import.meta.url));

export function runOverview(
  args: readonly string[],
  cwd: string = overviewFixtureRoot,
): { status: number | null; stdout: string; stderr: string } {
  ensureFixtureGitMarker(overviewFixtureRoot);
  return runSymnavBinary(args, { cwd });
}

export function snapshot(name: string): string {
  return join(snapshotsDirectory, name);
}
