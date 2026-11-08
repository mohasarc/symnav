import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("nested-config-cases");
const aliasImport =
  'src/vs/editor/user.ts\n├── 1: import { HistoryNavigator2 } from "vs/base/history";  [import]';
const aliasUsage = "return new HistoryNavigator2();  [usage]";

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav refs e2e (tsconfig below the workspace root)", () => {
  it("finds references through a paths alias declared by a nested tsconfig", () => {
    const r = runSymnavBinary(["refs", "HistoryNavigator2"], { cwd: fixtureRoot });

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(aliasImport);
    expect(r.stdout).toContain(aliasUsage);
  });
});
