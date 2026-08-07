import type { RunSymnavBinaryResult } from "@symnav/testing";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "./ensure-fixture-git-marker.js";

export class FixtureRunner {
  readonly fixtureRoot: string;

  constructor(fixtureName: string) {
    this.fixtureRoot = fixturePath(fixtureName);
  }

  run(args: readonly string[]): RunSymnavBinaryResult {
    ensureFixtureGitMarker(this.fixtureRoot);
    return runSymnavBinary(args, { cwd: this.fixtureRoot });
  }
}
