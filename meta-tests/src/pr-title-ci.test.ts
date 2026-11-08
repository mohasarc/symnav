import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ALLOWED_TYPES = ["feat", "fix", "perf", "docs", "chore", "refactor", "test", "ci", "build"];

describe("PR title check", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/pr-title.yml"), "utf8");

  it("runs on every pull request title change", () => {
    expect(workflow).toMatch(
      /^on:\n {2}pull_request:\n {4}types: \[opened, edited, synchronize, reopened\]$/m,
    );
  });

  it("runs one pr-title job that can only read pull requests", () => {
    expect(workflow).toMatch(/^jobs:\n {2}pr-title:$/m);
    expect(workflow).toMatch(/^ {4}permissions:\n {6}pull-requests: read$/m);
  });

  it("uses action-semantic-pull-request", () => {
    expect(workflow).toMatch(/uses: amannn\/action-semantic-pull-request@v\d+/);
  });

  it("allows exactly the release types", () => {
    expect(listedTypes()).toEqual(ALLOWED_TYPES);
  });

  it("rejects every scope", () => {
    expect(workflow).toContain("requireScope: false");
    expect(workflow).toMatch(/disallowScopes: \|\n {12}\.\+$/m);
  });

  it("requires a capitalized subject", () => {
    expect(workflow).toContain("subjectPattern: ^[A-Z].*$");
  });

  function listedTypes(): string[] {
    const block = /types: \|\n((?: {12}\S+\n)+)/.exec(workflow);
    if (!block) throw new Error("Missing types block");
    return block[1]!.trim().split(/\s+/);
  }
});
