import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixturePath } from "@symnav/testing";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binPath = join(cliRoot, "dist", "cli.js");
const expectedVersion = (
  JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as { version: string }
).version;

function runSymnav(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd: fixturePath("trivial-project"),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("symnav CLI e2e", () => {
  it("symnav --version prints the package version and exits 0", () => {
    const r = runSymnav(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${expectedVersion}\n`);
    expect(r.stderr).toBe("");
  });

  it("symnav -v is equivalent to --version", () => {
    const r = runSymnav(["-v"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${expectedVersion}\n`);
    expect(r.stderr).toBe("");
  });

  it("symnav with no args exits non-zero with usage on stderr", () => {
    const r = runSymnav([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage/i);
  });
});
