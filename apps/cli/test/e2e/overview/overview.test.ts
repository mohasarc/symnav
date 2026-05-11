import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath } from "@symnav/testing";
import { ensureFixtureGitMarker } from "./ensure-fixture-git-marker.js";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const binPath = join(cliRoot, "dist", "cli.js");
const fixtureRoot = fixturePath("overview-cases");
const snapshotsDir = new URL("./__snapshots__/overview/", import.meta.url).pathname;

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runSymnavOverview(
  args: readonly string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
    const r = runSymnavOverview(["--cwd", fixtureRoot, "overview", outside], fixtureRoot);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    const normalized = r.stderr
      .split(outside)
      .join("<outsidePath>")
      .split(fixtureRoot)
      .join("<fixtureRoot>");
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
    const looseDir = mkdtempSync(join(tmpdir(), "overview-no-git-"));
    writeFileSync(join(looseDir, "a.ts"), "export const x = 1;\n");
    const r = runSymnavOverview(["--cwd", looseDir, "overview", "a.ts"], looseDir);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    const normalized = r.stderr.split(looseDir).join("<looseDir>");
    await expect(normalized).toMatchFileSnapshot(snapshot("no-git.expected.err"));
  });
});
