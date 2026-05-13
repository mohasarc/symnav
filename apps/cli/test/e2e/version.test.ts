import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const expectedVersion = (
  JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as { version: string }
).version;

function runSymnav(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  return runSymnavBinary(args, { cwd: fixturePath("trivial-project") });
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
