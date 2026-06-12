import type { DefinitionResult } from "@symnav/core";

export function renderDefinitionJson(result: DefinitionResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}
