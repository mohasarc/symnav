import { describe, expect, it } from "vitest";

import { noSupportedFilesFixtureRoot, runResolve, snapshot } from "./run-resolve.js";

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
      mode: string;
      symbols: readonly { identity: { segments: readonly { name: string }[] } }[];
      files: readonly string[];
    };
    expect(parsed.query).toBe("^to[A-Z].*");
    expect(parsed.mode).toBe("regex");
    expect(parsed.symbols.map((symbol) => symbol.identity.segments.at(-1)?.name)).toEqual([
      "toOrder",
      "toReceipt",
    ]);
    expect(parsed.files).toEqual(["src/toOrderHelpers.ts"]);
  });

  it.skip("matches symbol names case-insensitively", () => {
    const r = runResolve(["resolve", "--regex", "^toorder$"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("toOrder");
  });

  it("reports an invalid regex with the pattern stated once", () => {
    const r = runResolve(["resolve", "--regex", "["]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      'Cannot answer: invalid resolve regex "[": Unterminated character class.\n',
    );
    expect(r.status).toBe(1);
  });

  it("reports an invalid regex even when the workspace has no supported files", () => {
    const r = runResolve(["resolve", "--regex", "["], noSupportedFilesFixtureRoot);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      'Cannot answer: invalid resolve regex "[": Unterminated character class.\n',
    );
    expect(r.status).toBe(1);
  });

  it("rejects regex and fuzzy mode together", () => {
    const r = runResolve(["resolve", "--regex", "--fuzzy", "^to[A-Z].*"]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Cannot answer: --regex cannot be combined with --fuzzy.\n");
    expect(r.status).toBe(1);
  });
});
