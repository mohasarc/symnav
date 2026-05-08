import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOverviewCasesGitMarker,
  overviewCasesRoot,
  removeOverviewCasesGitMarker,
} from "./overview-fixture.js";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binPath = join(cliRoot, "dist", "cli.js");
const snapshotsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "__snapshots__",
  "overview",
);

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runSymnavOverview(args: readonly string[], cwd: string): RunResult {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  createOverviewCasesGitMarker();
});

afterAll(() => {
  removeOverviewCasesGitMarker();
});

describe("symnav overview e2e — happy path", () => {
  it("class-with-methods.ts renders class hierarchy", async () => {
    const r = runSymnavOverview(["overview", "class-with-methods.ts"], overviewCasesRoot());
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    await expect(r.stdout).toMatchFileSnapshot(
      join(snapshotsDir, "class-with-methods.expected.txt"),
    );
  });

  it("top-level-functions.ts renders function declarations and overloads", async () => {
    const r = runSymnavOverview(["overview", "top-level-functions.ts"], overviewCasesRoot());
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    await expect(r.stdout).toMatchFileSnapshot(
      join(snapshotsDir, "top-level-functions.expected.txt"),
    );
  });

  it("top-level-constants.ts renders variables and default export", async () => {
    const r = runSymnavOverview(["overview", "top-level-constants.ts"], overviewCasesRoot());
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    await expect(r.stdout).toMatchFileSnapshot(
      join(snapshotsDir, "top-level-constants.expected.txt"),
    );
  });

  it("nested-symbols.ts renders namespace, interface, and enum members", async () => {
    const r = runSymnavOverview(["overview", "nested-symbols.ts"], overviewCasesRoot());
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    await expect(r.stdout).toMatchFileSnapshot(
      join(snapshotsDir, "nested-symbols.expected.txt"),
    );
  });

  it("empty.ts renders the (no symbols) sentinel", () => {
    const r = runSymnavOverview(["overview", "empty.ts"], overviewCasesRoot());
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("Overview: empty.ts\n\n(no symbols)\n");
  });
});
