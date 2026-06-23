import { execFileSync } from "node:child_process";
import type { GitHistory, HistoryEntry, RecentHistoryQuery } from "@symnav/core";

export type GitCommandRunner = (args: readonly string[], cwd: string) => string;

const FIELD_SEPARATOR = "\x1f";
const FIELD_COUNT = 4;

const runGit: GitCommandRunner = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

export class NodeGitHistory implements GitHistory {
  public constructor(private readonly run: GitCommandRunner = runGit) {}

  public async recentHistory(query: RecentHistoryQuery): Promise<readonly HistoryEntry[]> {
    try {
      const raw = this.run(logArgsFor(query), query.workspaceRoot);
      const entries = parseEntries(raw);
      return entries === undefined ? [] : entries.slice(0, query.limit);
    } catch {
      return [];
    }
  }
}

function logArgsFor(query: RecentHistoryQuery): readonly string[] {
  const range = `${query.range.startLine},${query.range.endLine}:${query.file}`;
  const format = ["%h", "%ad", "%an", "%s"].join(FIELD_SEPARATOR);
  return ["log", `-L${range}`, "--no-patch", "--date=short", `--format=${format}`];
}

function parseEntries(raw: string): HistoryEntry[] | undefined {
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const entries: HistoryEntry[] = [];
  for (const line of lines) {
    const fields = line.split(FIELD_SEPARATOR);
    if (fields.length !== FIELD_COUNT) {
      return undefined;
    }
    const [sha, date, author, subject] = fields;
    if (sha === undefined || date === undefined || author === undefined || subject === undefined) {
      return undefined;
    }
    entries.push({ sha, date, author, subject });
  }
  return entries;
}
