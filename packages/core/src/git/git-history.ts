import type { LineRange } from "../intermediate-representation/types.js";

export interface HistoryEntry {
  readonly sha: string; // short sha
  readonly date: string; // YYYY-MM-DD
  readonly author: string;
  readonly subject: string;
}

export interface RecentHistoryQuery {
  readonly workspaceRoot: string;
  readonly file: string; // workspace-relative, POSIX
  readonly range: LineRange;
  readonly limit: number;
}

export interface GitHistory {
  recentHistory(query: RecentHistoryQuery): Promise<readonly HistoryEntry[]>;
}
