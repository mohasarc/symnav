import { describe, expect, it, beforeAll } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";
import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("overview-cases");

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav overview unsupported inputs", () => {
  it("reports directory inputs as unsupported source files", () => {
    const result = runSymnavBinary(["overview", "src/rules"], { cwd: fixtureRoot });

    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Cannot answer: src/rules is a directory; expected a source file.\n",
    );
  });
});
