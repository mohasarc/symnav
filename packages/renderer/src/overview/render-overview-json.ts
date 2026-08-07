import type { OverviewExpansionResult } from "@symnav/core";

export function renderOverviewJson(result: OverviewExpansionResult): string {
  return JSON.stringify(wireShapeOf(result), sortedKeyReplacer, 2) + "\n";
}

type OverviewWireShape = Pick<
  OverviewExpansionResult,
  "file" | "entries" | "request" | "diagnostics"
>;

function wireShapeOf(result: OverviewExpansionResult): OverviewWireShape {
  const wire: OverviewWireShape = {
    file: result.file,
    entries: result.entries,
    request: result.request,
  };
  if (result.diagnostics === undefined) return wire;
  return { ...wire, diagnostics: result.diagnostics };
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
