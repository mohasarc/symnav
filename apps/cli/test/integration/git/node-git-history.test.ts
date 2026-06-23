import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixturePath } from "@symnav/testing";
import { NodeGitHistory } from "../../../src/git/node-git-history.js";
import { ensureFixtureGitMarker } from "../../e2e/overview/ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("context-history-cases");
let nonRepoDir: string;

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
  nonRepoDir = mkdtempSync(join(tmpdir(), "symnav-non-repo-"));
});

afterAll(() => {
  rmSync(nonRepoDir, { recursive: true, force: true });
});

describe("NodeGitHistory against a frozen repo", () => {
  const history = new NodeGitHistory();

  it("returns commits touching the line range, newest first, capped at limit", async () => {
    const entries = await history.recentHistory({
      workspaceRoot: fixtureRoot,
      file: "greeter.ts",
      range: { startLine: 1, endLine: 3 },
      limit: 5,
    });
    expect(entries).toEqual([
      { sha: "f51a893", date: "2023-06-05", author: "Greeter Bot", subject: "trim the name" },
      { sha: "0c2b3ce", date: "2023-05-30", author: "Greeter Bot", subject: "add exclamation" },
      { sha: "a05474e", date: "2023-04-25", author: "Greeter Bot", subject: "greet with Hello" },
      {
        sha: "9e880b7",
        date: "2023-03-20",
        author: "Greeter Bot",
        subject: "use template literal",
      },
      { sha: "6e0d298", date: "2023-02-15", author: "Greeter Bot", subject: "return greeting" },
    ]);
  });

  it("returns [] for an untracked file", async () => {
    const entries = await history.recentHistory({
      workspaceRoot: fixtureRoot,
      file: "untracked.ts",
      range: { startLine: 1, endLine: 1 },
      limit: 5,
    });
    expect(entries).toEqual([]);
  });

  it("returns [] when the directory is not a git repo", async () => {
    const entries = await history.recentHistory({
      workspaceRoot: nonRepoDir,
      file: "greeter.ts",
      range: { startLine: 1, endLine: 3 },
      limit: 5,
    });
    expect(entries).toEqual([]);
  });
});
