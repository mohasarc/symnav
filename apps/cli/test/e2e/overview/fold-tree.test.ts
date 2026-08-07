import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("overview-cases");

function runOverview(args: readonly string[]) {
  return runSymnavBinary(args, { cwd: fixtureRoot });
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav overview e2e (fold tree)", () => {
  it("renders folded call headers and nested declarations without callback body lines", () => {
    const r = runOverview(["overview", "fold-tree.ts"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1-5: describe("x", () => {');
    expect(r.stdout).toContain("2-4: helper");
    expect(r.stdout).toContain("2 const helper = () => …");
    expect(r.stdout).not.toContain("return 1");
  });

  it("renders barrel re-export edges without loading target files", () => {
    const r = runOverview(["overview", "barrel.ts"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1: export * from "./top-level-functions";');
    expect(r.stdout).toContain('2: export { MyClass } from "./class-with-methods";');
    expect(r.stdout).toContain('3: export * as constants from "./top-level-constants";');
    expect(r.stdout).not.toContain("greet");
    expect(r.stdout).not.toContain("Example");
    expect(r.stdout).not.toContain("(no symbols)");
  });
});
