import type { SourceFile } from "ts-morph";
import type { FileSymbols } from "@symnav/core";

import { extractStatementDecls } from "./extract-children.js";

export function extractFileSymbols(args: {
  sourceFile: SourceFile;
  filePath: string;
}): FileSymbols {
  return {
    filePath: args.filePath,
    symbols: extractStatementDecls(args.sourceFile.getStatements()),
  };
}
