import type { SourceFile } from "ts-morph";
import { assignDisambiguators, type OverviewFileSymbols } from "@symnav/core";

import { extractStatementDecls } from "./extract-children.js";

export function extractFileSymbols(args: {
  sourceFile: SourceFile;
  filePath: string;
}): OverviewFileSymbols {
  const topLevel = extractStatementDecls(args.sourceFile.getStatements(), {
    file: args.filePath,
    ancestorNames: [],
  });
  return {
    file: args.filePath,
    symbols: assignDisambiguators(topLevel),
  };
}
