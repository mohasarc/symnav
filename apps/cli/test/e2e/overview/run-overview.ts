import { fixturePath, runSymnavBinary } from "@symnav/testing";
import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

export const overviewFixtureRoot = fixturePath("overview-cases");

export function runOverview(
  args: readonly string[],
  cwd: string = overviewFixtureRoot,
): { status: number | null; stdout: string; stderr: string } {
  ensureFixtureGitMarker(overviewFixtureRoot);
  return runSymnavBinary(args, { cwd });
}
