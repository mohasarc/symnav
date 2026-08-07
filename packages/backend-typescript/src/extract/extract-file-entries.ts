import type { SourceFile } from "ts-morph";
import { assignDisambiguators, type DiagnosticSink, type OverviewFileEntries } from "@symnav/core";

import { OverviewChildrenExtractor } from "./extract-overview-children.js";

export function extractFileEntries(args: {
  sourceFile: SourceFile;
  filePath: string;
  diagnostics?: DiagnosticSink | undefined;
}): OverviewFileEntries {
  const extractor = new OverviewChildrenExtractor({
    file: args.filePath,
    diagnostics: args.diagnostics,
  });
  const topLevel = extractor.extract(args.sourceFile.getStatements());
  return {
    file: args.filePath,
    entries: assignDisambiguators(topLevel),
  };
}
