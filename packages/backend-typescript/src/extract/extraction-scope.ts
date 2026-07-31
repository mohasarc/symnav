import type { DiagnosticSink, SymbolPathSegment } from "@symnav/core";

export interface ExtractionScope {
  readonly file: string;
  readonly symbolSegments: readonly SymbolPathSegment[];
  readonly diagnostics?: DiagnosticSink | undefined;
}

export function childSymbolScope(parent: ExtractionScope, name: string): ExtractionScope {
  return {
    file: parent.file,
    symbolSegments: [...parent.symbolSegments, { name }],
    diagnostics: parent.diagnostics,
  };
}
