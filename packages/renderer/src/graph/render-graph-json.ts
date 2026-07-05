import type { GraphResult } from "@symnav/core";

export function renderGraphJson(result: GraphResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
