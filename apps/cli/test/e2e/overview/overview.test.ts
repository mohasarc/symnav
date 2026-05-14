import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";
import { ensureFixtureGitMarker } from "./ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("overview-cases");
const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runSymnavOverview(
  args: readonly string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  return runSymnavBinary(args, { cwd });
}

function applyOrderedReplacements(
  input: string,
  replacements: readonly { find: string; replace: string }[],
): string {
  for (const outer of replacements) {
    for (const inner of replacements) {
      if (outer === inner) continue;
      if (outer.find.includes(inner.find)) {
        throw new Error(
          `applyOrderedReplacements: find ${JSON.stringify(inner.find)} is a substring of ${JSON.stringify(outer.find)} — replacements must not overlap`,
        );
      }
    }
  }
  return replacements.reduce((acc, { find, replace }) => acc.split(find).join(replace), input);
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav overview e2e (happy path)", () => {
  it("renders class-with-methods.ts", async () => {
    const r = runSymnavOverview(["overview", "class-with-methods.ts"], fixtureRoot);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("class-with-methods.expected.txt"));
  });

  it("renders top-level-functions.ts", async () => {
    const r = runSymnavOverview(["overview", "top-level-functions.ts"], fixtureRoot);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("top-level-functions.expected.txt"));
  });

  it("renders top-level-constants.ts", async () => {
    const r = runSymnavOverview(["overview", "top-level-constants.ts"], fixtureRoot);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("top-level-constants.expected.txt"));
  });

  it("renders nested-symbols.ts", async () => {
    const r = runSymnavOverview(["overview", "nested-symbols.ts"], fixtureRoot);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("nested-symbols.expected.txt"));
  });

  it("renders multi-line-signature.ts", async () => {
    const r = runSymnavOverview(["overview", "multi-line-signature.ts"], fixtureRoot);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("multi-line-signature.expected.txt"));
  });

  it("renders empty.ts as no symbols", async () => {
    const r = runSymnavOverview(["overview", "empty.ts"], fixtureRoot);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("Overview: empty.ts\n\n(no symbols)\n");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("empty.expected.txt"));
  });
});

describe("symnav overview e2e (user errors)", () => {
  it("reports an ignored target", async () => {
    const r = runSymnavOverview(["overview", "ignored.ts"], fixtureRoot);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    await expect(r.stderr).toMatchFileSnapshot(snapshot("ignored.expected.err"));
  });

  it("reports a missing target", async () => {
    const r = runSymnavOverview(["overview", "missing.ts"], fixtureRoot);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    await expect(r.stderr).toMatchFileSnapshot(snapshot("missing.expected.err"));
  });

  it("reports a target outside the workspace", async () => {
    const outside = join(fixtureRoot, "..", "trivial-project", "package.json");
    const r = runSymnavOverview(["overview", outside], fixtureRoot);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    const normalized = applyOrderedReplacements(r.stderr, [
      { find: outside, replace: "<outsidePath>" },
      { find: fixtureRoot, replace: "<fixtureRoot>" },
    ]);
    await expect(normalized).toMatchFileSnapshot(snapshot("outside.expected.err"));
  });

  it("reports an unsupported file extension", async () => {
    const r = runSymnavOverview(["overview", "package.json"], fixtureRoot);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    await expect(r.stderr).toMatchFileSnapshot(snapshot("unsupported.expected.err"));
  });
});

describe("symnav overview e2e (JSON output)", () => {
  it("renders class-with-methods.ts as JSON", async () => {
    const r = runSymnavOverview(["overview", "class-with-methods.ts", "--json"], fixtureRoot);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("class-with-methods.expected.json"));
  });

  it("renders multi-line-signature.ts as JSON", async () => {
    const r = runSymnavOverview(["overview", "multi-line-signature.ts", "--json"], fixtureRoot);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("multi-line-signature.expected.json"));
  });
});

describe("symnav overview e2e (determinism)", () => {
  it("produces byte-identical stdout across repeated runs", () => {
    const first = runSymnavOverview(["overview", "class-with-methods.ts"], fixtureRoot);
    const second = runSymnavOverview(["overview", "class-with-methods.ts"], fixtureRoot);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(second.stderr).toBe(first.stderr);
  });
});

describe("symnav overview e2e (no git workspace)", () => {
  it("reports when run outside of any git workspace", async () => {
    const looseDir = realpathSync(mkdtempSync(join(tmpdir(), "overview-no-git-")));
    writeFileSync(join(looseDir, "a.ts"), "export const x = 1;\n");
    const r = runSymnavOverview(["overview", "a.ts"], looseDir);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    const normalized = applyOrderedReplacements(r.stderr, [
      { find: looseDir, replace: "<looseDir>" },
    ]);
    await expect(normalized).toMatchFileSnapshot(snapshot("no-git.expected.err"));
  });
});
