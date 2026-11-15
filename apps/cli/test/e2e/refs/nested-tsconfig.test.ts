import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("nested-tsconfig-cases");
const historyNavigatorId = "src/vs/base/history.ts::HistoryNavigator";

interface JsonReference {
  readonly file: string;
  readonly line: number;
}

interface JsonRefsResult {
  readonly total: number;
  readonly references: readonly JsonReference[];
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav refs e2e (configuration below the workspace root)", () => {
  it("finds references made through the nested configuration's paths alias", () => {
    const r = runSymnavBinary(["refs", historyNavigatorId, "--json"], { cwd: fixtureRoot });

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as JsonRefsResult;
    expect(parsed.references.map(({ file, line }) => ({ file, line }))).toEqual([
      { file: "src/vs/app/user.ts", line: 1 },
      { file: "src/vs/app/user.ts", line: 3 },
      { file: "src/vs/app/user.ts", line: 4 },
    ]);
  });
});
