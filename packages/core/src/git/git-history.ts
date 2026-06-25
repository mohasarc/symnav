import type { LineRange } from "../intermediate-representation/types.js";

export interface HistoryEntry {
  readonly shortSha: string;
  readonly isoDate: string;
  readonly author: string;
  readonly subject: string;
}

export interface RecentHistoryQuery {
  readonly workspaceRoot: string;
  readonly workspaceRelativeFile: string;
  readonly range: LineRange;
  readonly limit: number;
}

export interface GitHistory {
  recentHistory(query: RecentHistoryQuery): Promise<readonly HistoryEntry[]>;
}
