import type { RefsResult } from "@symnav/core";

export function renderRefsJson(result: RefsResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}
