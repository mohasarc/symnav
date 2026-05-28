import type { ResolveResult } from "@symnav/core";

export function renderResolveJson(result: ResolveResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}
