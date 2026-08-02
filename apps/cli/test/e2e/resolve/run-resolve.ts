import { join } from "node:path";
import { fixturePath, runSymnavBinary } from "@symnav/testing";
import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

export const resolveFixtureRoot = fixturePath("resolve-cases");

const snapshotsDirectory = new URL("./__snapshots__/", import.meta.url).pathname;

export function runResolve(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  ensureFixtureGitMarker(resolveFixtureRoot);
  return runSymnavBinary(args, { cwd: resolveFixtureRoot });
}

export function snapshot(name: string): string {
  return join(snapshotsDirectory, name);
}
