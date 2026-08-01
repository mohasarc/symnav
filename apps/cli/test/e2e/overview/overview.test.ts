import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { overviewFixtureRoot, runOverview } from "./run-overview.js";

const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;

function snapshot(name: string): string {
  return join(snapshotsDir, name);
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

describe("symnav overview e2e (happy path)", () => {
  it("renders class-with-methods.ts", async () => {
    const r = runOverview(["overview", "class-with-methods.ts"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("class-with-methods.expected.txt"));
  });

  it("renders top-level-functions.ts", async () => {
    const r = runOverview(["overview", "top-level-functions.ts"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("top-level-functions.expected.txt"));
  });

  it("renders top-level-constants.ts", async () => {
    const r = runOverview(["overview", "top-level-constants.ts"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("top-level-constants.expected.txt"));
  });

  it("renders nested-symbols.ts", async () => {
    const r = runOverview(["overview", "nested-symbols.ts"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("nested-symbols.expected.txt"));
  });

  it("renders multi-line-signature.ts", async () => {
    const r = runOverview(["overview", "multi-line-signature.ts"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("multi-line-signature.expected.txt"));
  });

  it("renders empty.ts as no symbols", async () => {
    const r = runOverview(["overview", "empty.ts"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("Overview: empty.ts\n(no symbols)\n");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("empty.expected.txt"));
  });

  it("renders declarations nested inside executable control-flow blocks", async () => {
    const r = runOverview(["overview", "control-flow-declarations.ts", "--depth", "1"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("if (flag) {");
    expect(r.stdout).toContain("for (const item of items) {");
    expect(r.stdout).toContain("outer::insideIf");
    expect(r.stdout).toContain("outer::insideLoop");
  });
});

describe("symnav overview e2e (user errors)", () => {
  it("reports an ignored target", async () => {
    const r = runOverview(["overview", "ignored.ts"]);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    await expect(r.stderr).toMatchFileSnapshot(snapshot("ignored.expected.err"));
  });

  it("reports a missing target", async () => {
    const r = runOverview(["overview", "missing.ts"]);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    await expect(r.stderr).toMatchFileSnapshot(snapshot("missing.expected.err"));
  });

  it("reports a target outside the workspace", async () => {
    const outside = join(overviewFixtureRoot, "..", "trivial-project", "package.json");
    const r = runOverview(["overview", outside]);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    const normalized = applyOrderedReplacements(r.stderr, [
      { find: outside, replace: "<outsidePath>" },
      { find: overviewFixtureRoot, replace: "<fixtureRoot>" },
    ]);
    await expect(normalized).toMatchFileSnapshot(snapshot("outside.expected.err"));
  });

  it("reports an unsupported file extension", async () => {
    const r = runOverview(["overview", "package.json"]);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    await expect(r.stderr).toMatchFileSnapshot(snapshot("unsupported.expected.err"));
  });
});

describe("symnav overview e2e (JSON output)", () => {
  it("renders class-with-methods.ts as JSON", async () => {
    const r = runOverview(["overview", "class-with-methods.ts", "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("class-with-methods.expected.json"));
  });

  it("renders multi-line-signature.ts as JSON", async () => {
    const r = runOverview(["overview", "multi-line-signature.ts", "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("multi-line-signature.expected.json"));
  });
});

describe("symnav overview e2e (determinism)", () => {
  it("produces byte-identical stdout across repeated runs", () => {
    const first = runOverview(["overview", "class-with-methods.ts"]);
    const second = runOverview(["overview", "class-with-methods.ts"]);
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
    const r = runOverview(["overview", "a.ts"], looseDir);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    const normalized = applyOrderedReplacements(r.stderr, [
      { find: looseDir, replace: "<looseDir>" },
    ]);
    await expect(normalized).toMatchFileSnapshot(snapshot("no-git.expected.err"));
  });
});
