import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureFixtureGitMarker } from "./ensure-fixture-git-marker.js";

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "overview-cases-marker-"));
  mkdirSync(join(root, "dot-git"));
  writeFileSync(join(root, "dot-git", "HEAD"), "ref: refs/heads/main\n");
  return root;
}

describe("ensureFixtureGitMarker", () => {
  it("copies dot-git to .git when .git is absent", () => {
    const root = makeFixtureRoot();
    ensureFixtureGitMarker(root);
    expect(existsSync(join(root, ".git"))).toBe(true);
    expect(readFileSync(join(root, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  });

  it("is idempotent when .git already exists", () => {
    const root = makeFixtureRoot();
    ensureFixtureGitMarker(root);
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/other\n");
    ensureFixtureGitMarker(root);
    expect(readFileSync(join(root, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/other\n");
  });
});
