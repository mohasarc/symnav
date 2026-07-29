import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("extraction-v2-cases");
const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;
const warning =
  "Warning: skipped unrecognised statement syntax at src/unsupported-statement.ts:1 (ExportDeclaration)\n";

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runSymnav(args: readonly string[]) {
  return runSymnavBinary(args, { cwd: fixtureRoot });
}

function expectOnlyUnsupportedStatementWarning(stderr: string): void {
  expect(stderr).toBe(warning);
  expect(stderr.trimEnd().split("\n")).toHaveLength(1);
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav extraction diagnostics e2e", () => {
  it("skips known namespace export syntax silently", () => {
    const r = runSymnav(["overview", "src/known-ignored-namespace-export.ts"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("render");
    expect(r.stdout).not.toContain("katex");
    expect(r.stdout).not.toContain("Warning:");
  });

  it("writes unsupported extraction warnings to stderr and keeps overview stdout", async () => {
    const r = runSymnav(["overview", "src/unsupported-statement.ts"]);

    expectOnlyUnsupportedStatementWarning(r.stderr);
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(
      snapshot("overview-unsupported-statement.expected.txt"),
    );
  });

  it("keeps JSON overview parseable when warnings are written to stderr", () => {
    const r = runSymnav(["overview", "src/unsupported-statement.ts", "--json"]);

    expectOnlyUnsupportedStatementWarning(r.stderr);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      entries: readonly { identity: { segments: readonly { name: string }[] } }[];
    };
    expect(parsed.entries.map((entry) => entry.identity.segments.at(-1)?.name)).toEqual([
      "stillVisible",
    ]);
  });

  it("writes unsupported extraction warnings for resolve", async () => {
    const r = runSymnav(["resolve", "stillVisible"]);

    expectOnlyUnsupportedStatementWarning(r.stderr);
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("resolve-still-visible.expected.txt"));
  });

  it("writes unsupported extraction warnings for def", async () => {
    const r = runSymnav(["def", "stillVisible"]);

    expectOnlyUnsupportedStatementWarning(r.stderr);
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("def-still-visible.expected.txt"));
  });

  it("writes unsupported extraction warnings for refs", async () => {
    const r = runSymnav(["refs", "stillVisible"]);

    expectOnlyUnsupportedStatementWarning(r.stderr);
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("refs-still-visible.expected.txt"));
  });

  it("writes unsupported extraction warnings for context", async () => {
    const r = runSymnav(["context", "stillVisible"]);

    expectOnlyUnsupportedStatementWarning(r.stderr);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Context: stillVisible");
    expect(r.stdout).toContain("Definition");
    expect(r.stdout).toContain("Callers");
    expect(r.stdout).toContain("Callees");
    expect(r.stdout).toContain("References");
    expect(r.stdout).toContain("Recent History");
  });

  it("writes unsupported extraction warnings for graph", async () => {
    const r = runSymnav(["graph", "stillVisible"]);

    expectOnlyUnsupportedStatementWarning(r.stderr);
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("graph-still-visible.expected.txt"));
  });
});
