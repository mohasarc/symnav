import type { SourceFile } from "ts-morph";
import { assignDisambiguators, type DiagnosticSink, type OverviewFileSymbols } from "@symnav/core";

import { extractStatementDecls } from "./extract-children.js";

export function extractFileSymbols(args: {
  sourceFile: SourceFile;
  filePath: string;
  diagnostics?: DiagnosticSink | undefined;
}): OverviewFileSymbols {
  const topLevel = extractStatementDecls(args.sourceFile.getStatements(), {
    file: args.filePath,
    ancestorNames: [],
    diagnostics: args.diagnostics,
  });
  return {
    file: args.filePath,
    symbols: assignDisambiguators(topLevel),
  };
}
