import type { SourceFile } from "ts-morph";
import { assignDisambiguators, type DiagnosticSink, type OverviewFileEntries } from "@symnav/core";

import { extractOverviewChildren } from "./extract-overview-children.js";

export function extractFileEntries(args: {
  sourceFile: SourceFile;
  filePath: string;
  diagnostics?: DiagnosticSink | undefined;
}): OverviewFileEntries {
  const topLevel = extractOverviewChildren({
    nodes: args.sourceFile.getStatements(),
    scope: {
      file: args.filePath,
      symbolSegments: [],
      diagnostics: args.diagnostics,
    },
  });
  return {
    file: args.filePath,
    entries: assignDisambiguators(topLevel),
  };
}
