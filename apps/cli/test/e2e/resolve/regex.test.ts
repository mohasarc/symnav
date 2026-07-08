import { describe, expect, it } from "vitest";

import { noSupportedFilesFixtureRoot, runResolve, snapshot } from "./run-resolve.js";

describe("symnav resolve e2e (regex)", () => {
  it("renders symbols whose own names match the regex", async () => {
    const r = runResolve(["resolve", "--regex", "^to[A-Z].*"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("regex-to-converters.expected.txt"));
    expect(r.stdout).not.toContain("toInvoice");
    expect(r.stdout).not.toContain("converterNotes");
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

  it("matches own names without matching parent-only canonical id segments", async () => {
    const r = runResolve(["resolve", "--regex", "toOrder"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("regex-to-order-own-name.expected.txt"));
    expect(r.stdout).toContain("Converter::toOrder");
    expect(r.stdout).not.toContain("receiptOnly");
  });

  it("does not match source text when no symbol own name matches", async () => {
    const r = runResolve(["resolve", "--regex", "toInvoice"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("regex-text-only-no-match.expected.txt"));
  });

  it("rejects regex and fuzzy mode together", () => {
    const r = runResolve(["resolve", "--regex", "--fuzzy", "^to[A-Z].*"]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Cannot answer: --regex cannot be combined with --fuzzy.\n");
    expect(r.status).toBe(1);
  });

  it("rejects invalid regex syntax with the parser reason", () => {
    const r = runResolve(["resolve", "--regex", "["]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain('Cannot answer: invalid resolve regex "[": ');
    expect(r.stderr).toContain("Unterminated character class");
    expect(r.status).toBe(1);
  });

  it("renders empty sections when no symbol own names match", async () => {
    const r = runResolve(["resolve", "--regex", "^NoSuch"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("regex-no-match.expected.txt"));
  });
});
