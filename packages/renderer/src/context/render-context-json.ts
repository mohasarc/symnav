import type { ContextResult } from "@symnav/core";

export function renderContextJson(result: ContextResult): string {
  return `${JSON.stringify(result)}\n`;
}
