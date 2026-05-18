import type { SourceFile } from "ts-morph";
import type { OverviewFileSymbols } from "@symnav/core";

import { assignDisambiguators } from "./assign-disambiguators.js";
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
