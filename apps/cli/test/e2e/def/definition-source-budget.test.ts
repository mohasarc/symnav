import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("definition-source-cases");
const DEFINITION_TEXT_BUDGET = 12_000;

function runDef(args: readonly string[]) {
  return runSymnavBinary(["def", ...args], { cwd: fixtureRoot });
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav def --source e2e (text budget)", () => {
  it("prints later implementations as signatures and names them past the budget", () => {
    const r = runDef(["--source", "Provider::charge"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(DEFINITION_TEXT_BUDGET);
    expect(r.stdout).toContain(`… cut to fit ${DEFINITION_TEXT_BUDGET} chars`);
    expect(r.stdout).toContain(
      "… source not shown: src/providers/provider-6.ts::Provider6::charge",
    );
    expect(r.stdout).toContain("… more: def --source '<id>' for one definition, or --all");
  });

  it("cuts a long function's lines and names the omitted span", () => {
    const r = runDef(["--source", "src/long.ts::long"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(DEFINITION_TEXT_BUDGET);
    expect(r.stdout).toMatch(/… omitted: lines \d+-402 \(\d+ lines\)\n/);
    expect(r.stdout).toContain("… more: --all\n");
  });
});
