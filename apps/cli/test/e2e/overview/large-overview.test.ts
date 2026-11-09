import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("large-overview-cases");
const OVERVIEW_TEXT_BUDGET = 8_000;

function runLargeOverview(args: readonly string[]) {
  return runSymnavBinary(["overview", "large-overview.ts", ...args], { cwd: fixtureRoot });
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav overview e2e (size budget)", () => {
  it("keeps the whole file at depth 2 within the budget with a footer", () => {
    const r = runLargeOverview(["--depth", "2"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(OVERVIEW_TEXT_BUDGET);
    expect(r.stdout).toContain(`… cut to fit ${OVERVIEW_TEXT_BUDGET} chars:`);
  });

  it("drops a selected namespace to the deepest depth that fits", () => {
    const r = runLargeOverview(["--at", "Shapes", "--depth", "2"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(OVERVIEW_TEXT_BUDGET);
    expect(r.stdout).toContain("Shapes::Shape29\n");
    expect(r.stdout).toContain("showing depth 1 of 2");
  });

  it("prints the whole tree past the budget with --all", () => {
    const r = runLargeOverview(["--depth", "2", "--all"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(OVERVIEW_TEXT_BUDGET);
    expect(r.stdout).not.toContain("… cut to fit");
    expect(r.stdout).toContain("helper399\n");
  });
});
