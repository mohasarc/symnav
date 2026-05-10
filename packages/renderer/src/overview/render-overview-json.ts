import type { FileSymbols, SymbolDecl } from "@symnav/core";

interface JsonSymbolDecl {
  readonly kind: SymbolDecl["kind"];
  readonly name: string;
  readonly range: SymbolDecl["range"];
  readonly signatureSource: string;
  readonly children: readonly JsonSymbolDecl[];
}

interface JsonFileSymbols {
  readonly filePath: string;
  readonly symbols: readonly JsonSymbolDecl[];
}

export function renderOverviewJson(file: FileSymbols): string {
  const normalized: JsonFileSymbols = {
    filePath: file.filePath,
    symbols: file.symbols.map(toJsonDecl),
  };
  return JSON.stringify(normalized, sortedKeyReplacer, 2) + "\n";
}

function toJsonDecl(decl: SymbolDecl): JsonSymbolDecl {
  return {
    kind: decl.kind,
    name: decl.name,
    range: decl.range,
    signatureSource: decl.signatureSource,
    children: decl.children.map(toJsonDecl),
  };
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
