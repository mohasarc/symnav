import type { SourceFile } from "ts-morph";
import type { OverviewFileSymbols } from "@symnav/core";

import { extractStatementDecls } from "./extract-children.js";

export function extractFileSymbols(args: {
  sourceFile: SourceFile;
  filePath: string;
}): OverviewFileSymbols {
  return {
    file: args.filePath,
    symbols: extractStatementDecls(args.sourceFile.getStatements(), {
      file: args.filePath,
      ancestorNames: [],
    }),
  };
}
