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
      workspaceRelativeFile: "greeter.ts",
      range: { startLine: 1, endLine: 3 },
      limit: 5,
    });
    expect(entries).toEqual([
      {
        shortSha: "f51a893",
        isoDate: "2023-06-05",
        author: "Greeter Bot",
        subject: "trim the name",
      },
      {
        shortSha: "0c2b3ce",
        isoDate: "2023-05-30",
        author: "Greeter Bot",
        subject: "add exclamation",
      },
      {
        shortSha: "a05474e",
        isoDate: "2023-04-25",
        author: "Greeter Bot",
        subject: "greet with Hello",
      },
      {
        shortSha: "9e880b7",
        isoDate: "2023-03-20",
        author: "Greeter Bot",
        subject: "use template literal",
      },
      {
        shortSha: "6e0d298",
        isoDate: "2023-02-15",
        author: "Greeter Bot",
        subject: "return greeting",
      },
    ]);
  });

  it("returns [] for an untracked file", async () => {
    const entries = await history.recentHistory({
      workspaceRoot: fixtureRoot,
      workspaceRelativeFile: "untracked.ts",
      range: { startLine: 1, endLine: 1 },
      limit: 5,
    });
    expect(entries).toEqual([]);
  });

  it("returns [] when the directory is not a git repo", async () => {
    const entries = await history.recentHistory({
      workspaceRoot: nonRepoDir,
      workspaceRelativeFile: "greeter.ts",
      range: { startLine: 1, endLine: 3 },
      limit: 5,
    });
    expect(entries).toEqual([]);
  });
});
