import type { OverviewExpansionResult } from "@symnav/core";

export function renderOverviewJson(result: OverviewExpansionResult): string {
  return JSON.stringify(result, sortedKeyReplacer, 2) + "\n";
}

function sortedKeyReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    sorted[k] = v;
  }
  return sorted;
}
