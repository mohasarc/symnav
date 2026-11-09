import type { DefinitionResult } from "@symnav/core";

export function renderDefinitionJson(result: DefinitionResult): string {
  const { all: _textOnlyAll, ...wire } = result;
  return JSON.stringify(wire, null, 2) + "\n";
}
