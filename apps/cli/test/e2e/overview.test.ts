import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath } from "@symnav/testing";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binPath = join(cliRoot, "dist", "cli.js");

const FIXTURE = "overview-cases";

function ensureGitMarker(fixtureRoot: string): void {
  const gitDir = join(fixtureRoot, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
}

function runSymnav(
  args: readonly string[],
  cwd: string,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const snapshotsDir = resolve(dirname(fileURLToPath(import.meta.url)), "__snapshots__", "overview");

let fixtureRoot: string;

beforeAll(() => {
  fixtureRoot = fixturePath(FIXTURE);
  ensureGitMarker(fixtureRoot);
});

describe("symnav overview e2e — happy paths", () => {
  it("class-with-methods.ts matches snapshot", async () => {
    const r = runSymnav(["overview", "class-with-methods.ts"], fixtureRoot);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    await expect(r.stdout).toMatchFileSnapshot(
      join(snapshotsDir, "class-with-methods.expected.txt"),
    );
  });

  it("top-level-functions.ts matches snapshot", async () => {
    const r = runSymnav(["overview", "top-level-functions.ts"], fixtureRoot);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    await expect(r.stdout).toMatchFileSnapshot(
      join(snapshotsDir, "top-level-functions.expected.txt"),
    );
  });

  it("top-level-constants.ts matches snapshot", async () => {
    const r = runSymnav(["overview", "top-level-constants.ts"], fixtureRoot);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    await expect(r.stdout).toMatchFileSnapshot(
      join(snapshotsDir, "top-level-constants.expected.txt"),
    );
  });

  it("nested-symbols.ts matches snapshot", async () => {
    const r = runSymnav(["overview", "nested-symbols.ts"], fixtureRoot);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    await expect(r.stdout).toMatchFileSnapshot(join(snapshotsDir, "nested-symbols.expected.txt"));
  });

  it("empty.ts renders header + (no symbols)", () => {
    const r = runSymnav(["overview", "empty.ts"], fixtureRoot);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("Overview: empty.ts\n\n(no symbols)\n");
  });
});

describe("symnav overview e2e — error paths", () => {
  it("ignored.ts → exit 1, ignored-by-gitignore line", () => {
    const r = runSymnav(["overview", "ignored.ts"], fixtureRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Cannot answer: ignored.ts is ignored by .gitignore.\n");
  });

  it("missing.ts → exit 1, file-not-found line", () => {
    const r = runSymnav(["overview", "missing.ts"], fixtureRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Cannot answer: file not found: missing.ts.\n");
  });

  it("path outside workspace → exit 1, outside-workspace line", () => {
    const tmp = mkdtempSync(join(tmpdir(), "symnav-outside-"));
    try {
      const target = join(tmp, "outside.ts");
      writeFileSync(target, "export const x = 1;");
      const r = runSymnav(["overview", target], fixtureRoot);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Cannot answer:");
      expect(r.stderr).toContain("is outside the workspace");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("package.json → exit 1, unsupported-extension line", () => {
    const r = runSymnav(["overview", "package.json"], fixtureRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Cannot answer: unsupported file type .json");
  });
});

describe("symnav overview e2e — JSON and determinism", () => {
  it("class-with-methods.ts --json matches snapshot byte-for-byte", async () => {
    const r = runSymnav(["overview", "class-with-methods.ts", "--json"], fixtureRoot);
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(
      join(snapshotsDir, "class-with-methods.expected.json"),
    );
  });

  it("two runs of the same query produce identical stdout", () => {
    const a = runSymnav(["overview", "class-with-methods.ts"], fixtureRoot);
    const b = runSymnav(["overview", "class-with-methods.ts"], fixtureRoot);
    expect(a.stdout).toBe(b.stdout);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
  });
});

describe("symnav overview e2e — no-git workspace", () => {
  it("running from a directory with no .git ancestor exits 1 with not-in-workspace line", () => {
    const tmp = mkdtempSync(join(tmpdir(), "symnav-nogit-"));
    try {
      writeFileSync(join(tmp, "x.ts"), "export const x = 1;");
      const r = runSymnav(["overview", "x.ts"], tmp);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Cannot answer: not in a git workspace");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
