import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("resolve-cases");
const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runResolve(args: readonly string[]) {
  return runSymnavBinary(args, { cwd: fixtureRoot });
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav resolve e2e (regex)", () => {
  it("renders symbols whose own names match the regex", async () => {
    const r = runResolve(["resolve", "--regex", "^to[A-Z].*"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("regex-to-converters.expected.txt"));
  });

  it("emits JSON for regex matches", () => {
    const r = runResolve(["resolve", "--regex", "^to[A-Z].*", "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      query: string;
      fuzzy: boolean;
      symbols: readonly { identity: { segments: readonly { name: string }[] } }[];
      files: readonly string[];
    };
    expect(parsed.query).toBe("^to[A-Z].*");
    expect(parsed.fuzzy).toBe(false);
    expect(parsed.symbols.map((symbol) => symbol.identity.segments.at(-1)?.name)).toEqual([
      "toOrder",
      "toReceipt",
    ]);
    expect(parsed.files).toEqual([]);
  });
});
