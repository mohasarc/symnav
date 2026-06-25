import { describe, expect, it } from "vitest";
import type { RecentHistoryQuery } from "@symnav/core";
import { NodeGitHistory } from "./node-git-history.js";

const query: RecentHistoryQuery = {
  workspaceRoot: "/somewhere",
  workspaceRelativeFile: "greeter.ts",
  range: { startLine: 1, endLine: 3 },
  limit: 5,
};

describe("NodeGitHistory", () => {
  it("returns [] when the git runner throws", async () => {
    const history = new NodeGitHistory(() => {
      throw new Error("git: command not found");
    });
    expect(await history.recentHistory(query)).toEqual([]);
  });

  it("returns [] when git produces unparseable output", async () => {
    const history = new NodeGitHistory(() => "garbage without field separators\n");
    expect(await history.recentHistory(query)).toEqual([]);
  });

  it("returns [] when git produces no output", async () => {
    const history = new NodeGitHistory(() => "");
    expect(await history.recentHistory(query)).toEqual([]);
  });

  it("passes the limit to git log", async () => {
    let seenArgs: readonly string[] | undefined;
    const history = new NodeGitHistory((args) => {
      seenArgs = args;
      return "";
    });

    await history.recentHistory(query);

    expect(seenArgs).toContain("--max-count=5");
  });

  it("returns [] without calling git when the file is not workspace-relative POSIX", async () => {
    const rejectedFiles = [
      "/repo/greeter.ts",
      "../greeter.ts",
      "src\\greeter.ts",
      "C:/repo/greeter.ts",
    ];
    for (const workspaceRelativeFile of rejectedFiles) {
      const history = new NodeGitHistory(() => {
        throw new Error("git should not run");
      });
      await expect(history.recentHistory({ ...query, workspaceRelativeFile })).resolves.toEqual([]);
    }
  });
});
