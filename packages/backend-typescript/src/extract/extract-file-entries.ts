import type { SourceFile } from "ts-morph";
import { assignDisambiguators, type DiagnosticSink, type OverviewFileEntries } from "@symnav/core";

import { extractStatementDecls } from "./extract-children.js";

export function extractFileEntries(args: {
  sourceFile: SourceFile;
  filePath: string;
  diagnostics?: DiagnosticSink | undefined;
}): OverviewFileEntries {
  const topLevel = extractStatementDecls(args.sourceFile.getStatements(), {
    file: args.filePath,
    ancestorNames: [],
    diagnostics: args.diagnostics,
  });
  return {
    file: args.filePath,
    entries: assignDisambiguators(topLevel),
  };
}
